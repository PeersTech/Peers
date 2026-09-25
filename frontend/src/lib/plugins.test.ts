import {describe, expect, it} from "vitest";
import {validatePluginManifest} from "./plugins";

const valid = {
    id: "uppercase",
    name: "Uppercase",
    version: "1.0.0",
    capabilities: ["message:transform"],
};

describe("plugin manifests", () => {
    it("accepts an explicitly scoped transform plugin", () => {
        expect(validatePluginManifest(valid)).toEqual(valid);
    });

    it("rejects unknown capabilities", () => {
        expect(() => validatePluginManifest({...valid, capabilities: ["filesystem"]})).toThrow(/unsupported/);
    });

    it("rejects malformed versions and ids", () => {
        expect(() => validatePluginManifest({...valid, version: "latest"})).toThrow(/version/);
        expect(() => validatePluginManifest({...valid, id: "../evil"})).toThrow(/id/);
    });
});
