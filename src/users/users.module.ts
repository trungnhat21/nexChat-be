import { Module } from "@nestjs/common";
import { Neo4jUsersRepository } from "./neo4j-users.repository.js";
import { UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

@Module({
    controllers: [UsersController],
    providers: [UsersService, Neo4jUsersRepository],
    exports: [UsersService],
})
export class UsersModule {}
