import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import neo4j, {
    type Driver,
    type EagerResult,
} from "neo4j-driver";

type QueryParameters = Readonly<Record<string, unknown>>;

@Injectable()
export class Neo4jService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(Neo4jService.name);
    private driver: Driver | null = null;
    private database = "neo4j";

    constructor(private readonly configService: ConfigService) {}

    async onModuleInit(): Promise<void> {
        const uri = this.configService.get<string>("NEO4J_URI")?.trim();
        const username = this.configService.get<string>("NEO4J_USERNAME")?.trim();
        const password = this.configService.get<string>("NEO4J_PASSWORD");
        const configuredValues = [uri, username, password].filter(Boolean).length;

        if (configuredValues === 0) {
            this.logger.warn(
                "Neo4j is disabled because NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD are not configured",
            );
            return;
        }

        const missingVariables = [
            ["NEO4J_URI", uri],
            ["NEO4J_USERNAME", username],
            ["NEO4J_PASSWORD", password],
        ]
            .filter(([, value]) => !value)
            .map(([name]) => name);

        if (!uri || !username || !password) {
            throw new Error(
                `Missing Neo4j environment variables: ${missingVariables.join(", ")}`,
            );
        }

        this.database =
            this.configService.get<string>("NEO4J_DATABASE")?.trim() || "neo4j";

        let driver: Driver | null = null;

        try {
            driver = neo4j.driver(
                uri,
                neo4j.auth.basic(username, password),
            );
            await driver.verifyConnectivity({
                database: this.database,
            });
            this.driver = driver;
            this.logger.log(`Connected to Neo4j database "${this.database}"`);
        } catch (error) {
            await driver?.close();
            const message = error instanceof Error ? error.message : "Unknown error";
            this.logger.warn(
                `Unable to connect to Neo4j; continuing with MariaDB as the source of truth: ${message}`,
            );
        }
    }

    async onModuleDestroy(): Promise<void> {
        if (!this.driver) {
            return;
        }

        const driver = this.driver;
        this.driver = null;
        await driver.close();
        this.logger.log("Neo4j connection closed");
    }

    isEnabled(): boolean {
        return this.driver !== null;
    }

    getDriver(): Driver {
        if (!this.driver) {
            throw new Error("NEO4J_NOT_CONFIGURED");
        }

        return this.driver;
    }

    executeQuery(
        query: string,
        parameters: QueryParameters = {},
    ): Promise<EagerResult> {
        return this.getDriver().executeQuery(query, parameters, {
            database: this.database,
        });
    }
}
