"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Toggle } from "@/shared/components";
import { useTranslations } from "next-intl";

interface SystemPromptDraft {
  enabled: boolean;
  prefixPrompt: string;
  suffixPrompt: string;
}

interface ConflictState {
  isConflict: boolean;
  currentRevision?: number;
}

export default function SystemPromptTab() {
  const [draft, setDraft] = useState<SystemPromptDraft>({
    enabled: false,
    prefixPrompt: "",
    suffixPrompt: "",
  });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [conflictState, setConflictState] = useState<ConflictState>({ isConflict: false });

  const draftRef = useRef<SystemPromptDraft>(draft);
  const persistedSnapshotRef = useRef<SystemPromptDraft>(draft);
  const revisionRef = useRef<number | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const pendingDraftRef = useRef<SystemPromptDraft | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const t = useTranslations("settings");

  const applyLoadedSettings = useCallback(
    (data: {
      enabled?: boolean;
      prefixPrompt?: string;
      suffixPrompt?: string;
      settingsRevision?: number;
    }) => {
      const loaded: SystemPromptDraft = {
        enabled: data?.enabled ?? false,
        prefixPrompt: data?.prefixPrompt ?? "",
        suffixPrompt: data?.suffixPrompt ?? "",
      };
      const rev = typeof data?.settingsRevision === "number" ? data.settingsRevision : 0;

      setDraft(loaded);
      draftRef.current = loaded;
      persistedSnapshotRef.current = loaded;
      revisionRef.current = rev;
      setConflictState({ isConflict: false });
      setLoading(false);
    },
    []
  );

  const loadServerSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/system-prompt");
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      applyLoadedSettings(data);
    } catch {
      setLoading(false);
    }
  }, [applyLoadedSettings]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings/system-prompt")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          applyLoadedSettings(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [applyLoadedSettings]);

  const executeSave = async (targetDraft: SystemPromptDraft) => {
    isSavingRef.current = true;
    setStatus("");

    try {
      const currentRev = revisionRef.current;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (currentRev !== null && currentRev !== undefined) {
        headers["If-Match"] = String(currentRev);
      }

      const payload = {
        ...targetDraft,
        ...(currentRev !== null && currentRev !== undefined
          ? { expectedRevision: currentRev }
          : {}),
      };

      const res = await fetch("/api/settings/system-prompt", {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 409 || res.status === 428) {
        pendingDraftRef.current = null;
        isSavingRef.current = false;
        setConflictState({
          isConflict: true,
          currentRevision: data?.error?.currentRevision ?? data?.currentRevision,
        });
        return;
      }

      if (res.ok) {
        const nextRev =
          typeof data?.settingsRevision === "number"
            ? data.settingsRevision
            : (currentRev ?? 0) + 1;

        revisionRef.current = nextRev;
        persistedSnapshotRef.current = targetDraft;
        setStatus("saved");
        setTimeout(() => setStatus(""), 2000);

        if (pendingDraftRef.current) {
          const next = pendingDraftRef.current;
          pendingDraftRef.current = null;
          await executeSave(next);
        } else {
          isSavingRef.current = false;
        }
      } else {
        isSavingRef.current = false;
        setStatus("error");
      }
    } catch {
      isSavingRef.current = false;
      setStatus("error");
    }
  };

  const scheduleOrExecuteSave = (targetDraft: SystemPromptDraft) => {
    if (isSavingRef.current) {
      pendingDraftRef.current = targetDraft;
    } else {
      executeSave(targetDraft);
    }
  };

  const handleToggle = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const next: SystemPromptDraft = {
      ...draftRef.current,
      enabled: !draftRef.current.enabled,
    };
    setDraft(next);
    draftRef.current = next;
    scheduleOrExecuteSave(next);
  };

  const handleFieldChange = (field: "prefixPrompt" | "suffixPrompt", text: string) => {
    const next: SystemPromptDraft = {
      ...draftRef.current,
      [field]: text,
    };
    setDraft(next);
    draftRef.current = next;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      scheduleOrExecuteSave(draftRef.current);
    }, 800);
  };

  return (
    <Card>
      {conflictState.isConflict && (
        <div className="mb-5 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              warning
            </span>
            <div>
              <h4 className="text-sm font-semibold">{t("systemPromptConflictTitle")}</h4>
              <p className="text-xs text-amber-500/80">{t("systemPromptConflictDesc")}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadServerSettings}
            className="px-3 py-1.5 rounded-md bg-amber-500 text-white dark:text-neutral-900 text-xs font-medium hover:bg-amber-600 transition-colors shrink-0"
          >
            {t("systemPromptConflictReload")}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            edit_note
          </span>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">{t("globalSystemPrompt")}</h3>
        </div>
        <div className="flex items-center gap-3">
          {status === "saved" && (
            <span className="text-xs font-medium text-emerald-500 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">check_circle</span>{" "}
              {t("saved")}
            </span>
          )}
          <Toggle checked={draft.enabled} onChange={handleToggle} disabled={loading} />
        </div>
      </div>

      {draft.enabled && (
        <div className="flex flex-col gap-5">
          {/* Before Prompt — injected BEFORE agent/provider instructions */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-text-secondary flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">vertical_align_top</span>
              {t("beforePromptLabel")}
            </label>
            <p className="text-xs text-text-muted/70">{t("beforePromptDesc")}</p>
            <div className="relative">
              <textarea
                value={draft.prefixPrompt}
                onChange={(e) => handleFieldChange("prefixPrompt", e.target.value)}
                placeholder={t("beforePromptPlaceholder")}
                rows={9}
                className="w-full px-4 py-3 rounded-lg border border-border/50 bg-surface/30 text-sm
                           placeholder:text-text-muted/50 resize-y min-h-[220px]
                           focus:outline-none focus:ring-1 focus:ring-amber-500/30 focus:border-amber-500/50
                           transition-colors"
                disabled={loading}
              />
              <div className="absolute bottom-2 right-3 text-xs text-text-muted/60 tabular-nums">
                {t("chars", { count: draft.prefixPrompt.length })}
              </div>
            </div>
          </div>

          {/* After Prompt — injected AFTER agent/provider instructions */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-text-secondary flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">vertical_align_bottom</span>
              {t("afterPromptLabel")}
            </label>
            <p className="text-xs text-text-muted/70">{t("afterPromptDesc")}</p>
            <div className="relative">
              <textarea
                value={draft.suffixPrompt}
                onChange={(e) => handleFieldChange("suffixPrompt", e.target.value)}
                placeholder={t("afterPromptPlaceholder")}
                rows={9}
                className="w-full px-4 py-3 rounded-lg border border-border/50 bg-surface/30 text-sm
                           placeholder:text-text-muted/50 resize-y min-h-[220px]
                           focus:outline-none focus:ring-1 focus:ring-amber-500/30 focus:border-amber-500/50
                           transition-colors"
                disabled={loading}
              />
              <div className="absolute bottom-2 right-3 text-xs text-text-muted/60 tabular-nums">
                {t("chars", { count: draft.suffixPrompt.length })}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
