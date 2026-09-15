import { describe, expect, it } from "vitest";
import { CASE } from "./test-fixtures.js";
import { parseDataset, validateDataset } from "./validation.js";

describe("dataset validation", () => {
  it("accepts typed cases, optional notes, and empty answers/context for explicit evaluation", () => {
    expect(validateDataset([CASE, { ...CASE, id: "empty", answer: "", context: "", note: "For a reader" }])).toHaveLength(2);
  });
  it.each([null, {}, [], [CASE, CASE], [null], [{ ...CASE, id: " " }], [{ ...CASE, id: " padded " }],
    [{ ...CASE, id: 123 }], [{ ...CASE, answer: null }], [{ ...CASE, context: undefined }],
    [{ ...CASE, question: [] }], [{ ...CASE, label: "maybe" }], [{ ...CASE, note: false }]].map((value) => ({ value })))("rejects invalid datasets (%#)", ({ value }) => {
    expect(() => validateDataset(value)).toThrow(/Dataset|dataset/);
  });
  it("does not include raw dataset values or JSON parse details in errors", () => {
    expect(() => parseDataset("private invalid data")).toThrow("Dataset is not valid JSON.");
    expect(() => validateDataset([{ ...CASE, answer: { secret: "private" } }])).toThrow("Invalid dataset row 1");
  });
});
