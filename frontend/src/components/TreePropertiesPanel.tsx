import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import type { TreeProperties, TreePropertyValue } from "../lib/treeFrame";

interface TreePropertiesPanelProps {
  properties: TreeProperties;
  rail: string;
  kind?: string;
}

function isPropertyObject(value: TreePropertyValue): value is { [key: string]: TreePropertyValue } {
  return typeof value === "object" && value !== null;
}

function renderPropertyValue(value: TreePropertyValue): ReactNode {
  if (!isPropertyObject(value)) return String(value);

  return (
    <div className="tree-properties-nested">
      {Object.entries(value).map(([key, nestedValue]) => (
        <div className="tree-properties-row" key={key}>
          <span className="tree-properties-key">{key}</span>
          <span className="tree-properties-value">{renderPropertyValue(nestedValue)}</span>
        </div>
      ))}
    </div>
  );
}

export function TreePropertiesPanel({ properties, rail, kind }: TreePropertiesPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const entries = Object.entries(properties);

  if (entries.length === 0) return null;

  return (
    <div className="tree-properties-layout">
      <span className="tree-properties-rail" aria-hidden="true">
        {rail}
      </span>
      <span className="tree-properties-caret" aria-hidden="true" />
      {kind && (
        <span className="tree-properties-kind" aria-hidden="true">
          {kind}
        </span>
      )}
      <Collapsible
        className="tree-properties"
        open={open}
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
      >
        <CollapsibleTrigger className="tree-properties-trigger" type="button">
          <span>{t("tree.properties")}</span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </CollapsibleTrigger>
        {open && (
          <CollapsibleContent className="tree-properties-content">
            <div className="tree-properties-grid">
              {entries.map(([key, value]) => (
                <div className="tree-properties-row" key={key}>
                  <span className="tree-properties-key">{key}</span>
                  <span className="tree-properties-value">{renderPropertyValue(value)}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}
