/**
 * The plugins the example names, handed in by hand: a copy of the example outside the workspace cannot resolve
 * `plugins[].from` through node_modules, so every test that loads one loads it with this map.
 */
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import otel from '@wilanis/plugin-otel';
import queue from '@wilanis/plugin-queue';
import queueMemory from '@wilanis/plugin-queue-memory';
import reload from '@wilanis/plugin-reload';
import s3 from '@wilanis/plugin-s3';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import http from '../src/index.js';

/** Every plugin the example's project.json names, by the root it is used under, beside the built-in ones. */
export const EXAMPLE_PLUGINS = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blobs,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@queue': queue,
  '@queue-memory': queueMemory,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
  '@s3': s3,
};
