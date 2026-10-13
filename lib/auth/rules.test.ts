import { describe, expect, it } from "vitest";
import { messages, normalizedPassword, passwordLength, validateLogin, validateSignup } from "./rules";

const base = { email: "ann@example.com", password: "12345678", confirmPassword: "12345678" };
const address254 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;

describe("sign-up email rules", () => {
  it.each(["ann@example.com", "  Ann@Example.COM  ", "ann+music@example.com", address254])("accepts %s", (email) => {
    expect(validateSignup({ ...base, email })).toEqual({});
  });
  it("uses an exactly 254-character valid boundary fixture", () => expect(address254.length).toBe(254));
  it.each(["", "   "])("requires an email for %j", (email) => {
    expect(validateSignup({ ...base, email }).email).toBe(messages.emailRequired);
  });
  it.each(["ann", "ann@", "ann@example", "ann @example.com", "ann@exämple.com", `a${address254}`])("rejects %s", (email) => {
    expect(validateSignup({ ...base, email }).email).toBe(messages.emailInvalid);
  });
});

describe("normalized Unicode password rules", () => {
  it.each(["12345678", "😀".repeat(8), "a".repeat(128), " 12345678 ", "cafécafé", "cafe\u0301cafe\u0301"])("accepts %j", (password) => {
    expect(validateSignup({ ...base, password, confirmPassword: password })).toEqual({});
  });
  it.each([["", messages.passwordRequired], ["a".repeat(7), messages.passwordShort], ["a".repeat(129), messages.passwordLong], ["😀".repeat(129), messages.passwordLong], ["\ufb03".repeat(43), messages.passwordLong]])("rejects %j", (password, message) => {
    expect(validateSignup({ ...base, password, confirmPassword: password }).password).toBe(message);
  });
  it("counts after NFKC and does not trim", () => {
    expect(passwordLength("😀".repeat(8))).toBe(8);
    expect(passwordLength("\ufb03".repeat(3))).toBe(9);
    expect(normalizedPassword(" cafécafé ")).toBe(" cafécafé ");
  });
  it("compares normalized confirmation", () => {
    expect(validateSignup({ ...base, password: "cafécafé", confirmPassword: "cafe\u0301cafe\u0301" })).toEqual({});
    expect(validateSignup({ ...base, confirmPassword: "87654321" }).confirmPassword).toBe(messages.passwordMismatch);
  });
  it("reports all errors at once", () => {
    expect(validateSignup({ email: "", password: "", confirmPassword: "" })).toEqual({ email: messages.emailRequired, password: messages.passwordRequired });
  });
});

describe("log-in rules", () => {
  it("reports required fields together", () => {
    expect(validateLogin({ email: " ", password: "" }).errors).toEqual({ email: messages.emailRequired, password: messages.loginPasswordRequired });
  });
  it.each([{ email: "a".repeat(255), password: "12345678" }, { email: base.email, password: "a".repeat(129) }, { email: base.email, password: "😀".repeat(129) }, { email: base.email, password: "\ufb03".repeat(43) }])("identifies overlong input", (input) => {
    expect(validateLogin(input)).toEqual({ errors: {}, overlong: true });
  });
  it("does not add signup format or minimum-password rules to login", () => {
    expect(validateLogin({ email: "ann", password: "1" })).toEqual({ errors: {}, overlong: false });
  });
});
