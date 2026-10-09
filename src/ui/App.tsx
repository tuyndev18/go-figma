import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BREAKPOINTS, isBreakpoint } from "../core/ir";
import type { HubState } from "../shared/bridge";
import type { CodeSection, GenerateResult, SelectionSource, ToUIMessage, UIResult } from "../shared/messages";
import type { ProjectFile } from "../generators/project";
import { TARGETS, type Settings, type Target } from "../shared/settings";
import { connectBridge, type Bridge, type BridgeStatus } from "./bridge";
import { CopyButton, send } from "./common";
import { elideDataUris } from "./elide";
import { ErrorBoundary } from "./ErrorBoundary";
import { highlight } from "./highlight";
import { ChevronIcon, CopyIcon, ExportIcon, FrameIcon, ImageIcon, SlidersIcon, SparkleIcon, WarningIcon } from "./icons";
import { McpPanel } from "./McpPanel";
import { optimizeFiles } from "./optimize";
import { addImages, imageBytes, usePreviewHtml } from "./images";
import { createZip } from "./zip";

type Status = "loading" | "empty" | "ready" | "error";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [result, setResult] = useState<UIResult | null>(null);
  const [source, setSource] = useState<SelectionSource | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"code" | "preview">("code");
  const [section, setSection] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("disconnected");
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [hubState, setHubState] = useState<HubState | null>(null);
  const [serverPath, setServerPath] = useState<string | null>(null);
  const [mcpPanel, setMcpPanel] = useState(false);
  /** Read by the message handler, which is set up once. */
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;

  useEffect(() => {
    const bridge = connectBridge((request) => send({ type: "bridge-request", request }), {
      status: setBridgeStatus,
      hubState: setHubState,
    });
    setBridge(bridge);
    window.onmessage = (event: MessageEvent<{ pluginMessage?: ToUIMessage }>) => {
      const message = event.data.pluginMessage;
      if (!message) return;
      switch (message.type) {
        case "settings":
          setSettings(message.settings);
          break;
        case "loading":
          setStatus("loading");
          break;
        case "empty":
          setStatus("empty");
          setResult(null);
          break;
        case "images":
          addImages(message.images);
          break;
        case "result":
          setStatus("ready");
          setResult(message.result);
          setSource(message.source);
          setSection((i) => (i < message.result.sections.length ? i : 0));
          break;
        case "error":
          setStatus("error");
          setError(message.message);
          break;
        case "project":
          optimizeFiles(message.files, settingsRef.current?.optimizeImages ?? true)
            .then((files) => downloadProject(message.name, files))
            .finally(() => setExporting(false));
          break;
        case "project-failed":
          setExporting(false);
          break;
        case "bridge-response":
          // Image files for agents get the same optimization as exports.
          optimizeFiles(message.response, settingsRef.current?.optimizeImages ?? true)
            .catch(() => message.response)
            .then((response) => bridge.respond(response));
          break;
        case "mcp-server-path":
          setServerPath((path) => path ?? message.path);
          break;
      }
    };
    send({ type: "ui-ready", screen: { width: screen.availWidth, height: screen.availHeight } });
    return () => bridge.close();
  }, []);

  // Remembered so the MCP panel can show how to start the server while none runs.
  const reportedPath = hubState?.serverPath;
  useEffect(() => {
    if (!reportedPath || reportedPath === serverPath) return;
    setServerPath(reportedPath);
    send({ type: "remember-mcp-server-path", path: reportedPath });
  }, [reportedPath, serverPath]);

  const update = (patch: Partial<Settings>) => send({ type: "update-settings", settings: patch });
  const current = result?.sections[section];
  const agentCount = hubState?.sessions.length ?? 0;
  // A hub without agents was started with --hub; an older hub doesn't report agents at all.
  const mcpState = bridgeStatus === "disconnected" ? "off" : hubState && agentCount === 0 ? "idle" : "on";
  const showResult = !mcpPanel && result && status !== "empty" && status !== "error";

  return (
    <div className="app">
      <header className="topbar">
        <label className="target-select" title="Output stack">
          <select
            value={settings?.target ?? ""}
            disabled={!settings}
            onChange={(e) => update({ target: e.target.value as Target })}
          >
            {TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="select-chevron">
            <ChevronIcon />
          </span>
        </label>
        <span className="spacer" />
        {settings && <SettingsMenu settings={settings} update={update} />}
        <button
          className={`mcp-pill ${mcpState}`}
          aria-pressed={mcpPanel}
          title={
            mcpState === "on"
              ? "AI agents are connected through the GoApp Figma MCP server"
              : mcpState === "idle"
                ? "The GoApp Figma MCP server is running; no agent is using it"
                : "The GoApp Figma MCP server isn't running"
          }
          onClick={() => setMcpPanel((open) => !open)}
        >
          <span className="status-dot" />
          MCP
          {agentCount > 0 && <span className="pill-count">{agentCount}</span>}
        </button>
      </header>
      {status === "loading" && result && !mcpPanel && <div className="progress" />}

      {mcpPanel && (
        <ErrorBoundary area="MCP panel" resetKey={hubState}>
          <McpPanel bridge={bridge} status={bridgeStatus} hub={hubState} serverPath={serverPath} onClose={() => setMcpPanel(false)} />
        </ErrorBoundary>
      )}

      {!mcpPanel && status === "empty" && (
        <EmptyState title="Select a frame" caption="Pick a frame or layer on the canvas and its code shows up here." />
      )}
      {!mcpPanel && status === "error" && <EmptyState title="Couldn't generate code" caption={error} tone="danger" />}
      {!mcpPanel && status === "loading" && !result && <EmptyState title="Generating…" caption="Reading the layers from Figma." loading />}

      {showResult && (
        <>
          {source && (source.nodes.length > 1 || source.nodes.some((n) => n.breakpoint)) && (
            <BreakpointBar nodes={source.nodes} />
          )}
          <nav className="tabbar">
            <div className="tabs" role="tablist">
              {result.sections.map((s, i) => (
                <button
                  key={s.title}
                  role="tab"
                  aria-selected={view === "code" && section === i}
                  onClick={() => {
                    setView("code");
                    setSection(i);
                  }}
                >
                  {s.title}
                </button>
              ))}
              <button role="tab" aria-selected={view === "preview"} onClick={() => setView("preview")}>
                Preview
              </button>
            </div>
            <span className="spacer" />
            {view === "code" && current && (
              <CopyButton text={current.code} title="Copy code" className="btn-icon">
                <CopyIcon />
              </CopyButton>
            )}
            {result.images.length > 0 && <DownloadImagesButton images={result.images} optimize={settings?.optimizeImages ?? true} />}
            {settings && (
              <button
                className="btn-icon"
                disabled={exporting}
                title={`${EXPORT_LABEL[settings.target]}: one page per selected frame; frames tagged with breakpoints share one responsive page`}
                aria-label={EXPORT_LABEL[settings.target]}
                onClick={() => {
                  setExporting(true);
                  send({ type: "export-project" });
                }}
              >
                <ExportIcon />
              </button>
            )}
            {settings && source && (
              <CopyButton
                text={agentPrompt(source, settings.target)}
                title="Paste into Claude Code / Codex: the agent reads this selection through the GoApp Figma MCP server and implements it"
                className="btn-primary"
              >
                <SparkleIcon />
                Copy for AI
              </CopyButton>
            )}
          </nav>

          <main className="content">
            <ErrorBoundary key={`${view}-${section}`} area={view === "preview" ? "Preview" : "Code view"} resetKey={result}>
              {view === "code" && current && <CodeView section={current} />}
              {view === "preview" && <ResponsivePreview result={result} />}
            </ErrorBoundary>
          </main>

          {result.warnings.length > 0 && <Warnings warnings={result.warnings} />}
        </>
      )}
      <ResizeHandle />
    </div>
  );
}

function EmptyState({ title, caption, tone, loading }: { title: string; caption: string; tone?: "danger"; loading?: boolean }) {
  return (
    <div className="empty">
      <div className={`empty-card${tone ? ` ${tone}` : ""}`}>
        <span className={`empty-tile${loading ? " loading" : ""}`}>{tone ? <WarningIcon /> : <FrameIcon />}</span>
        <h2>{title}</h2>
        <p>{caption}</p>
      </div>
    </div>
  );
}

function SettingsMenu({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const options: { key: "useColorVariables" | "inlineSvg" | "optimizeImages"; label: string; caption: string }[] = [
    { key: "useColorVariables", label: "Color variables", caption: "var(--token, #fallback) for colors bound to variables" },
    { key: "inlineSvg", label: "Inline SVG", caption: "Vectors and small icons as inline <svg>" },
    { key: "optimizeImages", label: "Optimize images", caption: "Scale image files to 2× their size in the design and compress them" },
  ];
  return (
    <div className="menu-anchor" ref={ref}>
      <button className="btn-icon" aria-expanded={open} title="Code options" aria-label="Code options" onClick={() => setOpen(!open)}>
        <SlidersIcon />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="eyebrow">Code options</div>
          {options.map((o) => (
            <label key={o.key} className="menu-row">
              <span>
                <span className="menu-label">{o.label}</span>
                <span className="menu-caption">{o.caption}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings[o.key]}
                onChange={(e) => update({ [o.key]: e.target.checked })}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Line numbers are one sticky column beside the code, not a sticky marker per
 * line: thousands of sticky elements each get their own compositing layer, and
 * a long CSS file blanked the plugin window.
 */
function CodeView({ section }: { section: CodeSection }) {
  const { html, numbers } = useMemo(() => {
    const code = elideDataUris(section.code);
    const lines = code.split("\n").length;
    return { html: highlight(code, section.language), numbers: Array.from({ length: lines }, (_, i) => i + 1).join("\n") };
  }, [section]);
  return (
    <div className="card code-card">
      <pre className="gutter" aria-hidden="true">
        {numbers}
      </pre>
      <pre className="code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <footer className={`statusbar${open ? " open" : ""}`}>
      {open && (
        <ul className="warning-list">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <button className="statusbar-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <WarningIcon />
        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
        <span className="toggle-chevron">
          <ChevronIcon />
        </span>
      </button>
    </footer>
  );
}

/** Bottom-right grip: plugin windows can only be resized by the plugin itself. */
function ResizeHandle() {
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    // Screen coordinates: client coordinates shift as the window grows.
    const { screenX: x0, screenY: y0 } = event;
    const { innerWidth: w0, innerHeight: h0 } = window;
    const move = (e: PointerEvent) => send({ type: "resize", width: w0 + e.screenX - x0, height: h0 + e.screenY - y0 });
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return <div className="resize-handle" title="Drag to resize" onPointerDown={start} />;
}

function downloadZip(fileName: string, files: { path: string; bytes: Uint8Array }[]) {
  const url = URL.createObjectURL(new Blob([createZip(files)], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadProject(name: string, files: ProjectFile[]) {
  const encoder = new TextEncoder();
  downloadZip(
    `${name}.zip`,
    files.map((f) => ({ path: `${name}/${f.path}`, bytes: f.bytes ?? encoder.encode(f.text ?? "") })),
  );
}

const EXPORT_LABEL: Record<Target, string> = {
  "html-css": "Export site",
  "html-tailwind": "Export site",
  "react-tailwind": "Export Next.js app",
};

function DownloadImagesButton({ images, optimize }: { images: UIResult["images"]; optimize: boolean }) {
  const download = async () => {
    const files = images.map((i) => ({ path: `images/${i.fileName}`, bytes: imageBytes(i.hash) ?? new Uint8Array(), fit: i.fit }));
    downloadZip("images.zip", await optimizeFiles(files, optimize));
  };
  const title = `Download ${images.length} image${images.length === 1 ? "" : "s"}`;
  return (
    <button className="btn-icon with-count" title={title} aria-label={title} onClick={download}>
      <ImageIcon />
      <span className="icon-count">{images.length}</span>
    </button>
  );
}

/** Tag selected frames as mobile / tablet / desktop; tagged frames merge into one responsive page. */
function BreakpointBar({ nodes }: { nodes: SelectionSource["nodes"] }) {
  return (
    <section className="breakpoints">
      <span
        className="eyebrow"
        title="Frames tagged with a breakpoint merge into one responsive page; untagged frames stay separate pages"
      >
        Breakpoints
      </span>
      <div className="breakpoint-chips">
        {nodes.map((n) => (
          <label key={n.id} className="breakpoint-chip" title={n.name}>
            <span className="breakpoint-name">{n.name}</span>
            <select
              value={n.breakpoint ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                send({ type: "set-breakpoint", nodeId: n.id, breakpoint: isBreakpoint(value) ? value : null });
              }}
            >
              <option value="">None</option>
              {BREAKPOINTS.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

/** Prompt for an AI coding agent with the GoApp Figma MCP server installed. */
function agentPrompt(source: SelectionSource, target: Target): string {
  const link = (id: string) =>
    source.fileKey && /^\d+:\d+$/.test(id)
      ? ` ${figmaUrl(source.fileKey, source.fileName)}?node-id=${id.replace(":", "-")}`
      : "";
  const layers = source.nodes
    .map((n) => `- "${n.name}" (node id ${n.id}${n.breakpoint ? `, ${n.breakpoint} breakpoint` : ""})${link(n.id)}`)
    .join("\n");
  const responsive =
    source.nodes.filter((n) => n.breakpoint).length > 1
      ? "\nThe frames tagged with a breakpoint are one responsive page; the reference code already merges them mobile-first (md = 768px, lg = 1024px).\n"
      : "";
  const ids = JSON.stringify(source.nodes.map((n) => n.id));
  return `Implement this Figma design in this codebase, using the goapp-figma MCP server.

Figma file "${source.fileName}":
${layers}
${responsive}
Call get_design_context with nodeIds ${ids}, format "${target}" and assetsDir set to this project's static assets folder, then follow the instructions it returns: convert the reference code to this project's stack and conventions, reuse existing components and design tokens, and check the result against the screenshot. If it says the design is too large, work section by section from the outline it returns.
If the goapp-figma tools aren't available, stop and tell me.`;
}

/** Share link in Figma's own format: punctuation in the name becomes dashes. */
function figmaUrl(fileKey: string, fileName: string): string {
  const slug = fileName.replace(/[^A-Za-z0-9À-￿]+/g, "-");
  return `https://www.figma.com/design/${fileKey}/${encodeURIComponent(slug)}`;
}

/** A responsive page previews at each tagged frame's width, so its media queries apply as on a real screen. */
function ResponsivePreview({ result }: { result: UIResult }) {
  const [index, setIndex] = useState<number | null>(null);
  const html = usePreviewHtml(result.previewHtml, result.previewImages);
  const sizes = result.previewSizes;
  if (html === null) return <EmptyState title="Preparing images…" caption="Scaling the design's images down for the preview." loading />;
  if (!sizes) return <Preview html={html} size={result.previewSize} />;
  const current = index !== null && index < sizes.length ? index : sizes.length - 1;
  return (
    <div className="preview-stack">
      <div className="segmented" role="tablist">
        {sizes.map((s, i) => (
          <button key={s.label} role="tab" aria-selected={i === current} onClick={() => setIndex(i)}>
            {s.label} <span className="muted">{s.width}px</span>
          </button>
        ))}
      </div>
      <Preview html={html} size={sizes[current]} />
    </div>
  );
}

/**
 * The page renders at the design's width, scaled down to fit the panel, and as
 * tall as its content: the HTML usually ends up taller than the Figma frame
 * (real fonts, wrapping), and a frame-height iframe scrolled inside itself.
 * Reading the content height needs allow-same-origin; scripts stay disabled.
 */
function Preview({ html, size }: { html: string; size: GenerateResult["previewSize"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(size.height);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const style = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setScale(Math.min(1, room / Math.max(1, size.width)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size.width]);

  // Follow the content as fonts and images load.
  useEffect(() => {
    setHeight(size.height);
    const iframe = frame.current;
    if (!iframe) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = iframe.contentDocument;
      if (!doc?.documentElement) return;
      const content = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      if (content > 0) setHeight(content);
    };
    const onLoad = () => {
      measure();
      observer?.disconnect();
      const body = iframe.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [html, size.height]);

  return (
    <div className="preview" ref={ref}>
      <div className="preview-frame" style={{ width: size.width * scale, height: height * scale }}>
        <iframe
          ref={frame}
          title="Preview"
          sandbox="allow-same-origin"
          scrolling="no"
          srcDoc={html}
          style={{ width: size.width, height, transform: `scale(${scale})` }}
        />
      </div>
    </div>
  );
}
