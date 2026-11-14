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

/** Controlled collection page. Reads and actions remain with its caller. */
export interface EntityListPageProps {
  title: ReactNode;
  actions?: ReactNode;
  controls?: ReactNode;
  table?: EntityTableViewProps;
  /** Overrides the table, including for generic SQL/TypeScript rows. */
  children?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: ReactNode;
}

/** Shared record body; callers provide activity, views and authorized actions. */
export interface EntityRecordPageProps {
  entity: ViewEntity;
  owner: string;
  schema?: EntityTableSchema;
  title?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  summary?: ReactNode;
  children?: ReactNode;
  /** Content mode keeps the header and lets children own the body layout. */
  layout?: "record" | "content";
}

/** Saved identities are resolved through the visiting user's existing reads.
 * Authored names, status and callbacks are never accepted as identity. */
interface LiveReference {
  mode: "live";
  workspace: string;
  appearance?: "inline" | "row";
}
export interface AutomationReferenceProps extends LiveReference {
  automationId: string;
}
export interface AgentReferenceProps extends LiveReference {
  agentId: string;
}
export interface ConnectorReferenceProps extends LiveReference {
  connectorKey: string;
  connectionId?: number;
}
export interface JsonDiffProps {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Schema declarations use the entitySchema SDK's field names. List responses
 * supply entity_types / relationship_types; compose rules from listRules.
 * Rendering never applies a declaration. createType/createRelType require a
 * name; the graph alone permits omission and displays the slug. */
export interface SchemaSpec {
  entityTypes: Array<{
    slug: string;
    name?: string;
    description?: string;
    metadata_schema?: object;
    event_kinds?: object;
  }>;
  relationshipTypes: Array<{
    slug: string;
    name?: string;
    metadata_schema?: object;
    rules: Array<{
      source_entity_type_slug: string;
      target_entity_type_slug: string;
    }>;
  }>;
}

export type SchemaGraphProps =
  | { schema?: undefined; base?: never }
  | { schema: SchemaSpec; base?: "workspace" | SchemaSpec };

/** Read-only native definition body. Pass a saved object or an authored snapshot.
 * No fetching, code execution, saving or approval is performed by the body. */
export interface DefinitionProps {
  value: Record<string, unknown>;
}

export interface NativeComponentProps {
  SchemaGraph: SchemaGraphProps;
  AutomationDefinition: DefinitionProps;
  AgentDefinition: DefinitionProps;
  ConnectorDefinition: DefinitionProps;
  AutomationReference: AutomationReferenceProps;
  AgentReference: AgentReferenceProps;
  ConnectorReference: ConnectorReferenceProps;
  JsonDiff: JsonDiffProps;
  EntityListPage: EntityListPageProps;
  EntityRecordPage: EntityRecordPageProps;
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
  "SchemaGraph",
  "AutomationDefinition",
  "AgentDefinition",
  "ConnectorDefinition",
  "AutomationReference",
  "AgentReference",
  "ConnectorReference",
  "JsonDiff",
  "EntityListPage",
  "EntityRecordPage",
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
      globalThis as unknown as {
        __lobuViewNative?: Partial<
          Record<keyof NativeComponentProps, ComponentType<object>>
        >;
      }
    ).__lobuViewNative;
    const component = registry?.[name];
    if (!component)
      throw new Error(
        `Native component ${name} is unavailable in this host runtime.`
      );
    return createElement(component, props);
  };
}
export const EntityListPage = native("EntityListPage");
/** Read-only workspace schema, snapshot, or semantic schema comparison. */
export const SchemaGraph = native("SchemaGraph");
export const EntityRecordPage = native("EntityRecordPage");
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

export const AutomationReference = native("AutomationReference");
export const AgentReference = native("AgentReference");
export const ConnectorReference = native("ConnectorReference");
export const JsonDiff = native("JsonDiff");
/** Instructions, sources, triggers, outputs and code from an Automation snapshot. */
export const AutomationDefinition = native("AutomationDefinition");
/** Identity and settings from an Agent snapshot, using the native editor fields. */
export const AgentDefinition = native("AgentDefinition");
/** Connector capabilities, schemas and source from a definition snapshot. */
export const ConnectorDefinition = native("ConnectorDefinition");
