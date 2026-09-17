import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { createClient } from 'redis';
import type { RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType;

  constructor() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      throw new Error('REDIS_URL is not defined');
    }

    this.client = createClient({
      url: redisUrl,
    });

    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
  }

  async onModuleInit() {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  getClient() {
    return this.client;
  }

  async get(key: string) {
    return this.client.get(key);
  }

  async set(
    key: string,
    value: string,
    ttlSeconds?: number,
  ) {
    if (ttlSeconds !== undefined) {
      return this.client.set(key, value, {
        EX: ttlSeconds,
      });
    }

    return this.client.set(key, value);
  }

  async del(key: string) {
    return this.client.del(key);
  }
}