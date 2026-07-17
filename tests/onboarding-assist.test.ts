import { expect, test } from "bun:test";
import { answerAssist } from "../src/onboarding/assist";

test("ASSIST answers briefly then returns to the current fixed gate", () => {
  expect(answerAssist("what is this?", {
    question: "First: should I protect just this project, or watch your work everywhere on this machine?",
    options: ["Just this project", "Everywhere"],
    lookup: () => "VibeBloat finds repeated AI mistakes and adds tripwires.",
  })).toEqual({
    answer: "VibeBloat finds repeated AI mistakes and adds tripwires. Want more detail?",
    question: "First: should I protect just this project, or watch your work everywhere on this machine?",
    options: ["Just this project", "Everywhere"],
  });
});
