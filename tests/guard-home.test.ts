import { expect, test } from "bun:test";
import { guardDirectories, guardHomeForScope, guardHomes, globalGuardHome, onboardingHome, projectGuardHome } from "../src/guard-home";

const environment = { USERPROFILE: "C:\\Users\\vibe" } as NodeJS.ProcessEnv;
const project = "D:\\code\\demo";

test("guard homes layer global then project by default", () => {
  expect(guardHomes(environment, project)).toEqual([globalGuardHome(environment), projectGuardHome(project)]);
  expect(guardDirectories(environment, project)).toEqual(["C:\\Users\\vibe\\.vibebloat\\guards", "D:\\code\\demo\\.vibebloat\\guards"]);
});

test("VIBEBLOAT_HOME remains an exclusive legacy override", () => {
  const override = { ...environment, VIBEBLOAT_HOME: "E:\\isolated" } as NodeJS.ProcessEnv;
  expect(guardHomes(override, project)).toEqual(["E:\\isolated"]);
  expect(guardDirectories(override, project)).toEqual(["E:\\isolated\\guards"]);
  expect(guardHomeForScope("repo", override, project)).toBe("E:\\isolated");
  expect(onboardingHome(override, project)).toBe("E:\\isolated");
});

test("scope selects project or machine write target without migration", () => {
  expect(guardHomeForScope("repo", environment, project)).toBe("D:\\code\\demo\\.vibebloat");
  expect(guardHomeForScope("machine", environment, project)).toBe("C:\\Users\\vibe\\.vibebloat");
  expect(onboardingHome(environment, project)).toBe("D:\\code\\demo\\.vibebloat");
});
