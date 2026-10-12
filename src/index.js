// The worker's entry point: hands the Workers socket API to the mail sender,
// so the rest of the code also runs in Node for tests (test/run.mjs).
import { connect } from "cloudflare:sockets";
import worker, { setConnect } from "./worker.js";

setConnect(connect);
export default worker;
