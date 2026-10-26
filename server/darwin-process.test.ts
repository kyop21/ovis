import { describe, expect, it } from "bun:test";
import { darwinStartTime, darwinTerminal, procTerminalDevice } from "./darwin-process.ts";

describe("macOS kernel process record", () => {
  it("reads the controlling terminal's device from kinfo_proc, and none for NODEV or a short answer", () => {
    const answer = new Uint8Array(648).fill(0xff);
    const view = new DataView(answer.buffer);
    view.setInt32(572, 0x1000001, true);
    expect(procTerminalDevice(answer)).toBe(0x1000001);
    view.setInt32(572, -1, true);
    expect(procTerminalDevice(answer)).toBeNull();
    expect(procTerminalDevice(answer.subarray(0, 575))).toBeNull();
    expect(procTerminalDevice(new Uint8Array(0))).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("tells what `ps` told, for a live process and none for a missing one", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "tty=", "-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      const [tty, ...lstart] = ps.stdout.toString().trim().split(/\s+/);
      const started = darwinStartTime(child.pid);
      expect(started).not.toBeNull();
      expect(Math.floor(Number(started! / 1000n) / 1000) * 1000).toBe(Date.parse(`${lstart.join(" ")} UTC`));
      expect(darwinTerminal(child.pid)).toBe(tty === "??" ? null : tty!);
    } finally { child.kill(); }
    expect(darwinStartTime(2147483647)).toBeNull();
    expect(darwinTerminal(2147483647)).toBeNull();
  });
});
