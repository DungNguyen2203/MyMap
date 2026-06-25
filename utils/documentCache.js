const { createClient } = require('redis');
const axios = require('axios');

const CACHE_TTL_SECONDS = parseInt(process.env.DOCUMENT_CACHE_TTL_SECONDS || String(7 * 24 * 60 * 60), 10);
const CACHE_PREFIX = 'mindmap:document:';

class DocumentCache {
  constructor() {
    this.memory = new Map();
    this.redisClientPromise = null;
    this.redisUrl = process.env.REDIS_URL;
    this.upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    this.upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  async get(key) {
    try {
      const value = await this.getRemote(key);
      if (value) return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) {
      console.warn(`[DocumentCache] Remote get failed for ${key}:`, error.message);
    }

    const local = this.memory.get(key);
    if (!local) return null;
    if (local.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return local.value;
  }

  async set(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
    const serialized = JSON.stringify(value);
    try {
      await this.setRemote(key, serialized, ttlSeconds);
    } catch (error) {
      console.warn(`[DocumentCache] Remote set failed for ${key}:`, error.message);
    }

    this.memory.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getRemote(key) {
    if (this.upstashUrl && this.upstashToken) {
      return this.upstashCommand(['GET', key]);
    }

    const client = await this.getRedisClient();
    return client ? client.get(key) : null;
  }

  async setRemote(key, serialized, ttlSeconds) {
    if (this.upstashUrl && this.upstashToken) {
      await this.upstashCommand(['SET', key, serialized, 'EX', String(ttlSeconds)]);
      return;
    }

    const client = await this.getRedisClient();
    if (client) await client.set(key, serialized, { EX: ttlSeconds });
  }

  async upstashCommand(command) {
    const response = await axios.post(
      this.upstashUrl.replace(/\/$/, ''),
      command,
      {
        headers: {
          Authorization: `Bearer ${this.upstashToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );
    if (response.data?.error) throw new Error(response.data.error);
    return response.data?.result;
  }

  async getRedisClient() {
    if (!this.redisUrl) return null;
    if (!this.redisClientPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on('error', (error) => console.warn('[DocumentCache] Redis error:', error.message));
      this.redisClientPromise = client.connect()
        .then(() => client)
        .catch((error) => {
          this.redisClientPromise = null;
          throw error;
        });
    }
    return this.redisClientPromise;
  }
}

const documentCache = new DocumentCache();

module.exports = {
  DocumentCache,
  documentCache,
  CACHE_PREFIX,
  CACHE_TTL_SECONDS
};
