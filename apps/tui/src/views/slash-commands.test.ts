import { describe, expect, it } from "vitest";
import {
  DASHBOARD_VIEW_COMMANDS,
  DASHBOARD_VIEW_COMMAND_IDS,
  SLASH_COMMANDS,
} from "./slash-commands.js";

describe("dashboard slash commands", () => {
  it("includes direct slash commands for every dashboard view", () => {
    const commandNames = new Set(SLASH_COMMANDS.map((command) => command.name));

    for (const view of DASHBOARD_VIEW_COMMANDS) {
      expect(commandNames.has(view.id)).toBe(true);
      expect(DASHBOARD_VIEW_COMMAND_IDS.has(view.id)).toBe(true);
    }
  });

  it("offers arrow-key completions for view arguments", async () => {
    const viewCommand = SLASH_COMMANDS.find((command) => command.name === "view");

    expect(viewCommand?.getArgumentCompletions).toBeDefined();
    const completions = await viewCommand?.getArgumentCompletions?.("age");

    expect(completions?.map((item) => item.value)).toContain("agents");
    expect(completions?.map((item) => item.value)).toContain("messages");
  });

  it("offers setup section completions", async () => {
    const setupCommand = SLASH_COMMANDS.find(
      (command) => command.name === "setup",
    );

    expect(setupCommand?.getArgumentCompletions).toBeDefined();
    const completions = await setupCommand?.getArgumentCompletions?.("tr");

    expect(completions?.map((item) => item.value)).toEqual(["tracker"]);
  });
});
