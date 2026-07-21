/*
 * Copyright 2026 The 25-ji-code-de Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import { Lucia, TimeSpan } from "lucia";
import type { Adapter, DatabaseSession, DatabaseUser as LuciaDatabaseUser } from "lucia";
import type { D1Database } from "@cloudflare/workers-types";

// Custom D1 Adapter for Lucia
class D1Adapter implements Adapter {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  }

  async getSessionAndUser(
    sessionId: string
  ): Promise<[session: DatabaseSession | null, user: LuciaDatabaseUser | null]> {
    const result = await this.db
      .prepare(
        `SELECT sessions.*, users.* FROM sessions
         INNER JOIN users ON sessions.user_id = users.id
         WHERE sessions.id = ?`
      )
      .bind(sessionId)
      .first();

    if (!result) {
      return [null, null];
    }

    const session: DatabaseSession = {
      id: result.id as string,
      userId: result.user_id as string,
      expiresAt: new Date(result.expires_at as number),
      attributes: {}
    };

    const user: LuciaDatabaseUser = {
      id: result.user_id as string,
      attributes: {
        id: result.user_id as string,
        username: result.username as string,
        email: result.email as string,
        display_name: result.display_name as string | null,
        avatar_url: result.avatar_url as string | null,
        bio: result.bio as string | null
      }
    };

    return [session, user];
  }

  async getUserSessions(userId: string): Promise<DatabaseSession[]> {
    const results = await this.db
      .prepare("SELECT * FROM sessions WHERE user_id = ?")
      .bind(userId)
      .all();

    return results.results.map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      expiresAt: new Date(row.expires_at as number),
      attributes: {}
    }));
  }

  async setSession(session: DatabaseSession): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)"
      )
      .bind(session.id, session.userId, session.expiresAt.getTime())
      .run();
  }

  async updateSessionExpiration(sessionId: string, expiresAt: Date): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(expiresAt.getTime(), sessionId)
      .run();
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .bind(Date.now())
      .run();
  }
}

export function initializeLucia(db: D1Database) {
  const adapter = new D1Adapter(db);

  return new Lucia(adapter, {
    sessionExpiresIn: new TimeSpan(30, "d"),
    sessionCookie: {
      attributes: {
        secure: true,
        sameSite: "lax"
      }
    },
    getUserAttributes: (attributes) => {
      return {
        username: attributes.username,
        email: attributes.email,
        displayName: attributes.display_name,
        avatarUrl: attributes.avatar_url,
        bio: attributes.bio
      };
    }
  });
}

export interface DatabaseUser {
  id: string;
  username: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
}

declare module "lucia" {
  interface Register {
    Lucia: ReturnType<typeof initializeLucia>;
    DatabaseUserAttributes: DatabaseUser;
  }
}
