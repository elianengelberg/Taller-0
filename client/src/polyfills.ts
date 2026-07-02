// simple-peer pulls in readable-stream/buffer, which assume a couple of
// Node globals exist. Provide minimal browser polyfills instead of a full
// node-stdlib shim. Must be imported before any module that touches
// simple-peer.
import { Buffer } from "buffer";
import process from "process";

const globalTarget = globalThis as typeof globalThis & {
  process?: unknown;
  Buffer?: unknown;
};

globalTarget.process = globalTarget.process ?? process;
globalTarget.Buffer = globalTarget.Buffer ?? Buffer;
