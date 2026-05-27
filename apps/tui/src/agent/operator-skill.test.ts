import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildDashboardSystemPrompt } from "./index.js";
import { loadDashboardOperatorSkillPrompt } from "./operator-skill.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("dashboard operator skill loading", () => {
  it("embeds the maintained operator skill with dashboard-specific caveats", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-tui-skill-"));
    tempDirs.push(root);
    const roomDir = join(root, "room", ".agentroom");
    await mkdir(roomDir, { recursive: true });
    await writeFile(
      join(roomDir, "config.yaml"),
      [
        "room:",
        "  id: test-room",
        "runtime:",
        "  default: fake",
        "runtimes:",
        "  fake:",
        "    type: fake",
        "storage:",
        "  driver: jsonl",
        "  path: events.jsonl",
      ].join("\n"),
    );
    await writeFile(
      join(roomDir, "AGENTS.md"),
      "# AgentRoom Protocol\n\nUse the room work tracker.",
    );
    const skillDir = join(root, "skills", "agentroom-operator");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: agentroom-operator",
        "---",
        "# AgentRoom Operator",
        "",
        "Use AgentRoom tools to manage runtime agents.",
      ].join("\n"),
    );

    const prompt = loadDashboardOperatorSkillPrompt(join(root, "room"), {
      env: {},
      moduleDir: join(root, "apps", "tui", "dist"),
    });

    expect(prompt).toContain("Embedded AgentRoom room protocol");
    expect(prompt).toContain("# AgentRoom Protocol");
    expect(prompt).toContain("Use the room work tracker.");
    expect(prompt).toContain("Embedded AgentRoom operator skill");
    expect(prompt).toContain("do not have direct shell or filesystem access");
    expect(prompt).toContain("# AgentRoom Operator");
    expect(prompt).toContain("Use AgentRoom tools to manage runtime agents.");
    expect(prompt).not.toContain("name: agentroom-operator");
  });

  it("can be disabled for tests or constrained deployments", () => {
    expect(
      loadDashboardOperatorSkillPrompt(process.cwd(), {
        env: {
          AGENTROOM_TUI_OPERATOR_SKILL: "off",
          AGENTROOM_TUI_ROOM_PROTOCOL: "off",
        },
      }),
    ).toBeUndefined();
  });

  it("appends the operator skill prompt to the Pi agent system prompt", () => {
    const prompt = buildDashboardSystemPrompt({
      agentId: "dashboard",
      roomId: "agent-room",
      cwd: "/repo",
      operatorSkillPrompt: "Embedded operator material",
    });

    expect(prompt).toContain("You are the AgentRoom dashboard agent");
    expect(prompt).toContain("Embedded operator material");
  });
});
