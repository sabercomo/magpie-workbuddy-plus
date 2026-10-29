import { initialize } from "./storage.mjs";

initialize();
const [command, argument] = process.argv.slice(2);
if (["status", "run", "pause", "resume"].includes(command)) {
  const { WorkBuddyPlusPlugin } = await import("./index.mjs");
  const { tool } = await WorkBuddyPlusPlugin();
  const result = command === "status" ? await tool.status.execute({}) : command === "run" ? await tool.run.execute({ action: argument || "all" }) : await tool.schedules.execute({ enabled: command === "resume" });
  console.log(JSON.stringify(result, null, 2));
} else throw new Error("用法：bun cli.mjs status | run [all|checkin|activity|tasks|travel|bonus|night|keepalive|inspect] | pause | resume");
