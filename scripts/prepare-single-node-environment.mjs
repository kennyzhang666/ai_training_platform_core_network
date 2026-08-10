#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEYS = Object.freeze([
  'TRUSTED_GATEWAY_HMAC_SECRET',
  'LDAP_GATEWAY_SESSION_SECRET',
  'EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET',
]);

function replaceAssignment(source, key, value) {
  const expression = new RegExp(`^${key}=.*$`, 'm');
  if (!expression.test(source)) throw new Error(`environment template is missing ${key}`);
  return source.replace(expression, `${key}=${value}`);
}

export async function createSingleNodeEnvironment({ template, output }) {
  const templatePath = resolve(template);
  const outputPath = resolve(output);
  await access(templatePath, constants.R_OK);
  try {
    await access(outputPath, constants.F_OK);
    throw new Error(`environment file already exists: ${outputPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const gatewaySecret = randomBytes(48).toString('base64url');
  const sessionSecret = randomBytes(48).toString('base64url');
  const values = {
    TRUSTED_GATEWAY_HMAC_SECRET: gatewaySecret,
    LDAP_GATEWAY_SESSION_SECRET: sessionSecret,
    EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET: gatewaySecret,
  };
  let content = await readFile(templatePath, 'utf8');
  for (const key of SECRET_KEYS) content = replaceAssignment(content, key, values[key]);
  if (!content.endsWith('\n')) content += '\n';

  await mkdir(dirname(outputPath), { recursive: true });
  let handle;
  try {
    handle = await open(outputPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await rm(outputPath, { force: true });
    }
    throw error;
  }
  await handle.close();
  return outputPath;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--template', '--output'].includes(name) || !value) {
      throw new Error('usage: prepare-single-node-environment.mjs --template PATH --output PATH');
    }
    result[name.slice(2)] = value;
  }
  if (!result.template || !result.output) throw new Error('both --template and --output are required');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createSingleNodeEnvironment(parseArguments(process.argv.slice(2)))
    .then((path) => process.stdout.write(`已生成配置文件：${path}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
