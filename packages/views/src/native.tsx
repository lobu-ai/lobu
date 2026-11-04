/** Public prop contracts for the native components built by Owletto.
 * Implementations are supplied by the host artifact, using the shell's React. */
import {
  createElement,
  type ComponentType,
  type ReactNode,
  type ComponentProps,
} from "react";
import type { ValueFormat } from "@lobu/core/json-template";

export interface ViewEntity {
  id: number | string | null;
  name: string;
  entity_type: string;
  parent_id?: number | null;
  slug: string;
  parent_slug?: string | null;
  parent_entity_type?: string | null;
  domain?: string;
  organization_id?: string;
  metadata?: Record<string, unknown>;
  relationships?: Record<
    string,
    Array<{ id: number; name: string; slug: string; entity_type: string }>
  >;
  created_at?: string;
  // Stats from entities_with_stats view
  total_content?: number | null;
  active_connections?: number | null;
  automations_count?: number | null;
  children_count?: number | null;
  parent_name?: string | null;
}

export interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  readOnly?: boolean;
  format?: string;
  items?: SchemaProperty;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  "x-image"?: boolean;
  "x-email"?: boolean;
  "x-table-column"?: boolean;
  "x-table-label"?: string;
  "x-currency"?: boolean;
  "x-link-entity-type"?: string;
  "x-link-lookup-field"?: string;
  /** Display labels keyed by stringified enum value. */
  "x-enum-labels"?: Record<string, string>;
  /** Omitted from schema-driven field lists without clearing the stored value. */
  "x-hidden"?: boolean;
  // Set on derived ("view") entity-type columns — these are computed, never
  // user-editable, so they must not surface as form inputs.
  "x-measure"?: unknown;
  "x-dimension"?: unknown;
}

interface MetadataTableProperty {
  title?: string;
  description?: string;
  enum?: string[];
  format?: string;
  "x-table-column"?: boolean;
  "x-table-label"?: string;
  "x-image"?: boolean;
  "x-link-entity-type"?: string;
  "x-link-lookup-field"?: string;
  // Explicit currency annotation. Preferred over the legacy name-based guess so
  // authored templates and columns agree on which fields are money.
  "x-currency"?: boolean;
  "x-hidden"?: boolean;
  "x-enum-labels"?: Record<string, string>;
}

export interface EntityTableSchema {
  properties?: Record<string, MetadataTableProperty>;
  "x-table-relationships"?: Array<{
    relationship_type: string;
    label: string;
  }>;
}

export interface EntityTableViewProps {
  entities: ViewEntity[];
  owner: string;
  schema?: EntityTableSchema;
  entityTypeIcon?: string;
  isDerived: boolean;
  measureColumns: string[];
  linkedEntityLookups: Record<
    string,
    Record<string, { slug: string; entity_type: string; name: string }>
  >;
  hasAnyParents: boolean;
  sorting: Array<{ id: string; desc: boolean }>;
  onSortingChange: (
    update:
      | Array<{ id: string; desc: boolean }>
      | ((
          previous: Array<{ id: string; desc: boolean }>
        ) => Array<{ id: string; desc: boolean }>)
  ) => void;
  visibleColumns?: string[];
  /** Columns the header's picker offers; no picker without it. */
  columnChoices?: { field: string; label: string }[];
  onVisibleColumnsChange?: (visible: string[]) => void;
  // Pagination footer — the table owns its own footer so the switcher renders a
  // single view node. Shown only when there are rows or the user has paged.
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
  pageTitle: string;
  onPrevPage: () => void;
  onNextPage: () => void;
}

export interface SpecField {
  key: string;
  prop: SchemaProperty;
  /** Overrides the schema label (derived columns keep their source names). */
  label?: string;
  /** Right-aligned digits for scanning measures. */
  numeric?: boolean;
}

export interface SpecSheetContext {
  ownerSlug: string;
  orgContext?: { organizationId?: string | null; slug?: string | null };
  controls?: Record<
    string,
    { set_by?: string | null; set_at?: string; note?: string | null }
  >;
  /** Opens an object-array field in the peek pane; without it the count is plain text. */
  openField?: (field: SpecField) => void;
  /** The field the peek pane shows now. */
  openFieldKey?: string;
  /** Fields with unsaved edits. */
  dirtyKeys?: readonly string[];
}

export interface NativeComponentProps {
  EntityTableView: EntityTableViewProps;
  RecordSpecSheet: {
    fields: SpecField[];
    values: Record<string, unknown>;
    context: SpecSheetContext;
    fieldLimit?: number;
  };
  SchemaValue: {
    value: unknown;
    prop?: SchemaProperty;
    format?: ValueFormat;
    resolveLink?: (raw: string) => { label: string; to: string } | undefined;
    empty?: ReactNode;
    className?: string;
  };
  EntityAvatar: {
    metadata: Record<string, unknown> | null | undefined;
    metadataSchema: Record<string, unknown> | null | undefined;
    name: string;
    typeIcon?: string | null;
    className?: string;
    iconClassName?: string;
    initialsFallback?: boolean;
  };
  Button: ComponentProps<"button"> & {
    variant?:
      | "default"
      | "destructive"
      | "outline"
      | "secondary"
      | "ghost"
      | "link"
      | null;
    size?: "default" | "sm" | "lg" | "icon" | null;
    asChild?: boolean;
  };
  Badge: ComponentProps<"span"> & {
    variant?: "default" | "secondary" | "destructive" | "outline";
  };
  Tabs: { defaultValue: string; children?: ReactNode };
  TabsList: { label?: string; children?: ReactNode };
  TabsTrigger: { value: string; children?: ReactNode };
  TabsContent: { value: string; children?: ReactNode };
}
export type NativeComponents = {
  [K in keyof NativeComponentProps]: ComponentType<NativeComponentProps[K]>;
};
export const NATIVE_COMPONENT_NAMES = [
  "EntityTableView",
  "RecordSpecSheet",
  "SchemaValue",
  "EntityAvatar",
  "Button",
  "Badge",
  "Tabs",
  "TabsList",
  "TabsTrigger",
  "TabsContent",
] as const satisfies readonly (keyof NativeComponents)[];
export const NATIVE_COMPONENT_GLOBAL = "__lobuViewNative";

function native<K extends keyof NativeComponents>(
  name: K
): ComponentType<NativeComponentProps[K]> {
  return function NativeComponent(props: NativeComponentProps[K]) {
    const registry = (
      globalThis as typeof globalThis & { __lobuViewNative?: NativeComponents }
    ).__lobuViewNative;
    const component = registry?.[name];
    if (!component)
      throw new Error(
        `Native component ${name} is unavailable in this host runtime.`
      );
    return createElement(
      component as ComponentType<NativeComponentProps[K]>,
      props
    );
  };
}
export const EntityTableView = native("EntityTableView");
export const RecordSpecSheet = native("RecordSpecSheet");
export const SchemaValue = native("SchemaValue");
export const EntityAvatar = native("EntityAvatar");
export const Button = native("Button");
export const Badge = native("Badge");
export const Tabs = native("Tabs");
export const TabsList = native("TabsList");
export const TabsTrigger = native("TabsTrigger");
export const TabsContent = native("TabsContent");
