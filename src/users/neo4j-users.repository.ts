import { Injectable } from "@nestjs/common";
import { Neo4jService } from "../neo4j/neo4j.service.js";

export interface GraphUser {
    id: string;
    email: string;
    status: string;
    userName: string | null;
    firstName: string | null;
    lastName: string | null;
    avatar: string | null;
    deleted: boolean;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

@Injectable()
export class Neo4jUsersRepository {
    constructor(private readonly neo4jService: Neo4jService) {}

    isEnabled(): boolean {
        return this.neo4jService.isEnabled();
    }

    async findActiveUserIds(): Promise<Set<string>> {
        const result = await this.neo4jService.executeQuery(`
            MATCH (user:User)
            WHERE coalesce(user.deleted, false) = false
            RETURN user.id AS id
        `);

        return new Set(
            result.records.map((record) => {
                const id: unknown = record.get("id");
                return String(id);
            }),
        );
    }

    async findActiveUserById(id: string): Promise<boolean> {
        const result = await this.neo4jService.executeQuery(
            `
                MATCH (user:User {id: $id})
                WHERE coalesce(user.deleted, false) = false
                RETURN user.id AS id
                LIMIT 1
            `,
            { id },
        );

        return result.records.length > 0;
    }

    async findActiveUserIdByEmail(email: string): Promise<string | null> {
        const result = await this.neo4jService.executeQuery(
            `
                MATCH (user:User {email: $email})
                WHERE coalesce(user.deleted, false) = false
                RETURN user.id AS id
                LIMIT 1
            `,
            { email },
        );

        const record = result.records[0];

        if (!record) {
            return null;
        }

        const id: unknown = record.get("id");
        return String(id);
    }

    async upsertUser(user: GraphUser): Promise<void> {
        await this.neo4jService.executeQuery(
            `
                MERGE (graphUser:User {id: $user.id})
                SET graphUser.email = $user.email,
                    graphUser.status = $user.status,
                    graphUser.userName = $user.userName,
                    graphUser.firstName = $user.firstName,
                    graphUser.lastName = $user.lastName,
                    graphUser.avatar = $user.avatar,
                    graphUser.deleted = $user.deleted,
                    graphUser.deletedAt = $user.deletedAt,
                    graphUser.createdAt = $user.createdAt,
                    graphUser.updatedAt = $user.updatedAt,
                    graphUser.lastSyncedAt = datetime()
            `,
            { user },
        );
    }
}
