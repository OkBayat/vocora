import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { config as loadEnvironment } from 'dotenv';
import mysql from 'mysql2/promise';

const DEFAULT_RETRIES = 30;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DATABASE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
const APPLICATION_USER_HOST = '%';

for (const environmentFile of [
  new URL('../.env', import.meta.url),
  new URL('../../.env', import.meta.url),
]) {
  loadEnvironment({
    path: fileURLToPath(environmentFile),
    quiet: true,
  });
}

const requiredEnvironmentVariable = (name, { trim = true } = {}) => {
  const rawValue = process.env[name];
  const value = trim ? rawValue?.trim() : rawValue;

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const positiveInteger = (value, fallback, name) => {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
};

const configuration = () => {
  const database = requiredEnvironmentVariable('DB_NAME');
  const appUser = requiredEnvironmentVariable('DB_USER');
  const adminUser = requiredEnvironmentVariable('DB_ADMIN_USER');

  if (
    database.length > 64 ||
    !DATABASE_IDENTIFIER_PATTERN.test(database)
  ) {
    throw new Error(
      'DB_NAME must contain only letters, numbers, or underscores and be at most 64 characters',
    );
  }

  if (appUser.length > 32) {
    throw new Error('DB_USER must be at most 32 characters');
  }

  if (appUser === adminUser) {
    throw new Error('DB_USER must be different from DB_ADMIN_USER');
  }

  const port = positiveInteger(process.env.DB_PORT, 3306, 'DB_PORT');
  if (port > 65_535) {
    throw new Error('DB_PORT must be between 1 and 65535');
  }

  return {
    host: process.env.DB_HOST?.trim() || '127.0.0.1',
    port,
    database,
    appUser,
    appPassword: requiredEnvironmentVariable('DB_PASSWORD', { trim: false }),
    adminUser,
    adminPassword: requiredEnvironmentVariable('DB_ADMIN_PASSWORD', {
      trim: false,
    }),
    retries: positiveInteger(
      process.env.DB_CONNECT_RETRIES,
      DEFAULT_RETRIES,
      'DB_CONNECT_RETRIES',
    ),
    retryDelayMs: positiveInteger(
      process.env.DB_CONNECT_RETRY_MS,
      DEFAULT_RETRY_DELAY_MS,
      'DB_CONNECT_RETRY_MS',
    ),
  };
};

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const connectWithRetry = async (connectionOptions, retries, retryDelayMs) => {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await mysql.createConnection({
        ...connectionOptions,
        connectTimeout: 10_000,
      });
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
        break;
      }

      console.info(
        `Database is not ready (attempt ${attempt}/${retries}); retrying in ${retryDelayMs}ms`,
      );
      await delay(retryDelayMs);
    }
  }

  throw new Error(
    `Could not connect to MySQL after ${retries} attempts`,
    { cause: lastError },
  );
};

const setupDatabase = async () => {
  const config = configuration();
  const commonConnectionOptions = {
    host: config.host,
    port: config.port,
  };

  const adminConnection = await connectWithRetry(
    {
      ...commonConnectionOptions,
      user: config.adminUser,
      password: config.adminPassword,
      multipleStatements: true,
    },
    config.retries,
    config.retryDelayMs,
  );

  try {
    await adminConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await adminConnection.query(`USE \`${config.database}\``);

    const schema = await readFile(
      fileURLToPath(new URL('../database/schema.sql', import.meta.url)),
      'utf8',
    );
    await adminConnection.query(schema);

    const account = [config.appUser, APPLICATION_USER_HOST];
    await adminConnection.query(
      'CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?',
      [...account, config.appPassword],
    );
    await adminConnection.query(
      'ALTER USER ?@? IDENTIFIED BY ?',
      [...account, config.appPassword],
    );
    await adminConnection.query(
      'REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?',
      account,
    );
    await adminConnection.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${config.database}\`.* TO ?@?`,
      account,
    );
  } finally {
    await adminConnection.end();
  }

  const applicationConnection = await connectWithRetry(
    {
      ...commonConnectionOptions,
      user: config.appUser,
      password: config.appPassword,
      database: config.database,
    },
    config.retries,
    config.retryDelayMs,
  );

  try {
    await applicationConnection.query('SELECT 1 FROM users LIMIT 0');
  } finally {
    await applicationConnection.end();
  }

  console.info(`Database '${config.database}' is ready`);
};

setupDatabase().catch((error) => {
  console.error('Database setup failed:', error.message);
  process.exitCode = 1;
});
