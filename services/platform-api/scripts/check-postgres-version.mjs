#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_POSTGRES_MAJOR = 14;

export function postgresMajorFromVersionNum(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{5,6}$/.test(text)) {
    throw new Error(`PostgreSQL server_version_num 无效：${text || '<empty>'}`);
  }
  return Math.trunc(Number(text) / 10_000);
}

export function assertPostgres14Compatible(serverVersionNum, serverVersion = '') {
  const major = postgresMajorFromVersionNum(serverVersionNum);
  if (major < MIN_POSTGRES_MAJOR) {
    const display = String(serverVersion).trim() || String(serverVersionNum);
    throw new Error(`平台要求 PostgreSQL 14 及以上版本，当前数据库为 ${display}`);
  }
  return major;
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient();
  try {
    const rows = await client.$queryRawUnsafe(
      `SELECT current_setting('server_version_num') AS "serverVersionNum", current_setting('server_version') AS "serverVersion"`,
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) throw new Error('无法读取 PostgreSQL 服务器版本');
    const major = assertPostgres14Compatible(row.serverVersionNum, row.serverVersion);
    console.log(`PostgreSQL ${major} 兼容检查通过（服务器版本 ${row.serverVersion}）`);
  } finally {
    await client.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
