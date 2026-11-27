// Pure AI rules shared by the assistant dock, the reader's event card and
// the compose surface. Rust owns job state; these only read it.
export * from "./agent";
export * from "./chatText";
export * from "./events";
export * from "./options";
export { PendingQueue, type PendingDeps } from "./pending";
