import { describe, expect, test } from "bun:test";
import { readViewDefinition } from "../contracts/tools/view-definition";

const module = (
  def: string,
  importLine = 'import { defineView } from "@lobu/views";'
) =>
  `${importLine}\nexport const view = defineView(${def});\nexport default function V() { return null; }\n`;

describe("readViewDefinition", () => {
  test("reads every declared field and applies the defaults", () => {
    expect(
      readViewDefinition(
        module(`{
          key: "pipeline",
          name: "Pipeline",
          description: "Open deals by stage",
          attach: [{ collection: "deal", when: { stage: "open" } }, { record: "deal", id: 7 }],
          params: { min: { type: "number", default: -1 } },
          actions: { win: { emits: "deal.won" } },
        }`)
      )
    ).toEqual({
      key: "pipeline",
      name: "Pipeline",
      description: "Open deals by stage",
      attach: [
        { collection: "deal", when: { stage: "open" } },
        { record: "deal", id: 7 },
      ],
      params: { min: { type: "number", default: -1 } },
      actions: { win: { emits: "deal.won" } },
    });
    expect(
      readViewDefinition(
        module(`{ key: 'card', attach: [{ workspace: true }] }`)
      )
    ).toEqual({
      key: "card",
      name: "card",
      description: "",
      attach: [{ workspace: true }],
      params: {},
      actions: {},
    });
  });

  test("accepts quoted keys, templates without substitutions and an aliased import", () => {
    expect(
      readViewDefinition(
        module(
          `{ "key": \`notes\`, 'attach': [{ "event": "note.added" }] }`,
          'import { defineView as dv, useScope } from "@lobu/views";'
        ).replace("defineView(", "dv(")
      ).attach
    ).toEqual([{ event: "note.added" }]);
  });

  test("never runs the module: a variable is rejected by name", () => {
    expect(() =>
      readViewDefinition(
        `import { defineView } from "@lobu/views";\nconst TYPE = "deal";\nexport const view = defineView({ key: "p", attach: [{ collection: TYPE }] });\nexport default function V() { return null; }`
      )
    ).toThrow(
      "defineView.attach[0].collection must be written out as a literal"
    );
    expect(() =>
      readViewDefinition(module(`{ key: "p", ...base, attach: [] }`))
    ).toThrow("a spread, shorthand, method or computed key");
    expect(() =>
      readViewDefinition(
        module(`{ key: "p", attach: [{ record: \`\${t}\` }] }`)
      )
    ).toThrow("a template with ${…}");
  });

  test("a retired attach shape points at the field to change", () => {
    expect(() =>
      readViewDefinition(
        module(`{ key: "p", attach: [{ type: "deal", placement: "tab" }] }`)
      )
    ).toThrow(/^defineView\.attach\.0: /);
  });

  test("requires the exported view declared with defineView from @lobu/views", () => {
    for (const source of [
      "export default function V() { return null; }",
      module(
        `{ key: "p", attach: [] }`,
        'import { defineView } from "./local";'
      ),
      `import { defineView } from "@lobu/views";\nconst view = defineView({ key: "p", attach: [] });`,
    ]) {
      expect(() => readViewDefinition(source)).toThrow(
        "the module must export const view = defineView"
      );
    }
  });

  test("requires a default-export component", () => {
    expect(() =>
      readViewDefinition(
        'import { defineView } from "@lobu/views";\nexport const view = defineView({ key: "p", attach: [] });'
      )
    ).toThrow("the module must have a default-export component");
    expect(
      readViewDefinition(
        'import { defineView } from "@lobu/views";\nexport const view = defineView({ key: "p", attach: [] });\nfunction V() { return null; }\nexport { V as default };'
      ).key
    ).toBe("p");
  });

  test("a param filter is checked against its schema", () => {
    const withFilter = (filter: string) =>
      module(
        `{ key: "p", attach: [], params: { region: { type: "string", filter: ${filter} } } }`
      );
    expect(
      readViewDefinition(
        withFilter(
          `{ label: "Region", options: [{ value: "EMEA", label: "Europe" }] }`
        )
      ).params.region?.filter?.label
    ).toBe("Region");
    expect(() =>
      readViewDefinition(withFilter(`{ label: "Region", multiple: true }`))
    ).toThrow(/^defineView\.params\.region\.filter/);
    expect(() => readViewDefinition(withFilter(`{ label: "" }`))).toThrow(
      /^defineView\.params\.region\.filter\.label/
    );
  });

  test("an unknown field is an error, not silently dropped", () => {
    expect(() =>
      readViewDefinition(module(`{ key: "p", attach: [], placement: "tab" }`))
    ).toThrow(/^defineView/);
  });
});
