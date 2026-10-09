# GoApp Figma – Design to Code

Plugin Figma chuyển layer đang chọn thành **HTML + CSS**, **React + Tailwind (v4)** hoặc **HTML + Tailwind**.
Chạy được ở cả Design mode (cửa sổ plugin có preview) và Dev Mode (panel Code gốc của Figma).
Plugin không gọi mạng, mọi xử lý đều diễn ra trong sandbox của Figma.

## Chạy thử

```bash
npm install
npm run build        # hoặc: npm run dev (watch)
```

Trong Figma Desktop: **Plugins → Development → Import plugin from manifest…** → chọn `manifest.json`.

- Design mode: chạy plugin, chọn một frame, code sẽ tự cập nhật khi đổi selection hoặc sửa layer.
- Dev Mode: mở panel Code, chọn ngôn ngữ "HTML + CSS" / "React + Tailwind" / "HTML + Tailwind".

## Export project

Nút **Export** trên thanh tab tải về `<tên-frame>.zip`. Mỗi frame đang chọn thành một page, frame đầu tiên là trang chủ.

| Target | Project |
| --- | --- |
| HTML + CSS | Site tĩnh: `index.html`, `<frame>.html`, `styles.css` dùng chung, `images/` |
| HTML + Tailwind | Site tĩnh dùng `@tailwindcss/browser@4` (CDN), `images/` |
| React + Tailwind | Next.js App Router: `app/page.jsx`, `app/<frame>/page.jsx`, Tailwind v4, `public/images/` |

Tên page/route lấy từ tên layer, bỏ dấu tiếng Việt ("Lời mời thi đấu" → `loi-moi-thi-dau`).

## Responsive (1 page – nhiều breakpoint)

Chọn các frame của cùng một màn (vd. `Mobile Shipping`, `Tablet Shipping`, `Desktop Shipping`), rồi ở thanh **Breakpoints** gán cho mỗi frame Mobile / Tablet / Desktop. Giá trị được lưu vào frame (plugin data), nên lần sau và MCP server đều đọc được.

Các frame đã gán sẽ gộp thành **một** page, viết theo kiểu mobile-first:

- Frame nhỏ nhất làm style gốc. Frame lớn hơn chỉ thêm phần khác biệt: `@media (min-width: 768px | 1024px)`, hoặc `md:` / `lg:` với Tailwind.
- Layer được ghép giữa các frame theo tag + **tên layer** (text/icon so thêm nội dung). Layer chỉ có ở một số frame sẽ bị ẩn (`display: none`) ở các frame còn lại.
- Con của flex bị đổi thứ tự giữa các frame sẽ được thêm `order`.
- Root của page có `width: 100%`, chiều cao frame chuyển thành `min-height`.
- Preview có nút chuyển viewport theo từng breakpoint.

Muốn markup gọn thì đặt tên layer giống nhau ở mọi frame. Layer tên khác nhau vẫn ra đúng giao diện nhưng bị lặp DOM, và plugin sẽ cảnh báo.

## MCP cho AI agent (Claude Code, Codex, Cursor…)

`npm run build` sinh thêm `dist/mcp.mjs`: MCP server (stdio) tự chứa, không cần `node_modules` khi chạy.
Agent gọi tool → server → WebSocket `localhost:3940` → cửa sổ plugin → sandbox chạy đúng pipeline của plugin.

```
AI agent ──stdio──▶ dist/mcp.mjs ──ws://localhost:3940──▶ plugin UI ──postMessage──▶ sandbox (normalize + generators)
```

Đăng ký server (đổi đường dẫn cho đúng máy):

```bash
# Claude Code
claude mcp add goapp-figma -- node C:/Users/tuyen/OneDrive/Desktop/go-figma/dist/mcp.mjs
# Codex
codex mcp add goapp-figma -- node C:/Users/tuyen/OneDrive/Desktop/go-figma/dist/mcp.mjs
```

Hoặc cấu hình tay: Codex `~/.codex/config.toml`

```toml
[mcp_servers.goapp-figma]
command = "node"
args = ["C:/Users/tuyen/OneDrive/Desktop/go-figma/dist/mcp.mjs"]
```

Cursor / Claude Desktop / client khác dùng JSON: `{ "mcpServers": { "goapp-figma": { "command": "node", "args": ["…/dist/mcp.mjs"] } } }`.

Sau đó mở plugin trong Figma Desktop (Design mode hoặc Dev Mode inspect) và **giữ cửa sổ plugin mở**; chấm **MCP** trên toolbar xanh là đã nối.

### Quản lý agent ngay trong plugin

Bấm nút **MCP** trên toolbar để mở panel quản lý:

- **Connected agents**: các phiên agent đang dùng GoApp Figma (Claude Code, Codex, Cursor…), thư mục project, số lần gọi tool và tool gọi gần nhất. Số trên nút `MCP · 2` là số phiên đang nối. Chấm vàng = server đang chạy nhưng chưa agent nào dùng.
- **Agents**: thêm / gỡ / cập nhật entry `goapp-figma` trong config MCP cấp user của từng agent, không cần gõ lệnh:

| Agent | File config |
| --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers`, scope user) |
| Codex | `~/.codex/config.toml` (`[mcp_servers.goapp-figma]`) |
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` |
| VS Code (Copilot) | `%APPDATA%/Code/User/mcp.json` (`servers`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

  Chỉ entry `goapp-figma` bị đụng tới; file cũ được sao lưu thành `<file>.goapp-figma.bak`. "Other path" nghĩa là entry đang trỏ tới bản `mcp.mjs` khác, bấm **Update** để trỏ về bản này. File JSONC có comment (thường là VS Code) không được ghi đè để khỏi mất comment, khi đó dùng **Copy** và dán tay. Sau khi đổi, khởi động lại agent (panel ghi cách cho từng agent).

Plugin không đọc được file trên máy, nên việc này do process MCP server làm. Chưa có agent nào chạy server thì chạy riêng hub để panel có chỗ nối:

```bash
npm run hub        # = node dist/mcp.mjs --hub, Ctrl+C để dừng
```

Hub riêng này không phục vụ agent nào; agent mở sau sẽ nối qua nó, và nếu một agent đang giữ port thì hub chờ để tiếp quản khi agent đó thoát.

Tool theo mô hình MCP chính thức của Figma: không đưa code thành phẩm mà đưa **ngữ cảnh để AI hiểu ý design** rồi tự viết theo codebase.

| Tool | Việc |
| --- | --- |
| `get_metadata` | Outline XML thưa (id, tên, type, x/y/w/h, auto layout, component, text), không style. Rẻ, dùng để định hướng frame lớn và chọn section. Không chọn gì → danh sách page + layer cấp 1 |
| `get_design_context` | **Tool chính.** Code tham chiếu (mặc định React + Tailwind) gắn `data-node-id`, `data-name`, `data-component`, `data-props`, `data-annotation`; danh sách component (variant, mô tả, link docs), token đang dùng, annotation, file ảnh/icon đã ghi ra đĩa (`assetsDir`), screenshot và chỉ dẫn cách chuyển sang stack của project. Code > 40k ký tự → trả outline để agent làm từng section |
| `get_variable_defs` | `scope: "selection"`: variable/style đang dùng (giá trị theo mode của layer). `scope: "file"`: mọi variable local + khối CSS `:root` |
| `get_screenshot` | Ảnh PNG/JPG để nhìn/đối chiếu (cạnh dài ≤ 2048px) |
| `generate_code` | Code thuần y như nút Copy (không gợi ý); `imagesDir` ghi ảnh |
| `export_project` | Ghi cả project chạy được ra `outputDir` (không ghi đè nếu không có `overwrite: true`) |

Mọi tool nhận `nodeIds` (`"12:34"`), hoặc `url` là link Figma (`…/design/<key>/<tên>?node-id=12-34`, cả link branch/proto). Bỏ trống = selection hiện tại. Link phải thuộc file đang mở trong Figma; khác file thì tool báo lỗi thay vì đọc nhầm layer trùng id. Output quá lớn được ghi ra `%TEMP%/goapp-figma/` và trả đường dẫn.

**Cách dùng chính:** chọn frame → bấm **Copy for AI** (nút xanh trong plugin) → dán vào Claude Code / Codex. Prompt đã có tên file, id layer (kèm link nếu plugin đọc được file key) và bảo agent gọi `get_design_context` rồi làm theo chỉ dẫn. Cũng có thể dán thẳng link Figma vào chat, hoặc dùng prompt `implement_design` (Claude Code: `/mcp__goapp-figma__implement_design`).

Ví dụ phần tử trong code tham chiếu:

```jsx
<div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[color:var(--primary,#3b82f6)]"
     data-node-id="1:5" data-name="Button" data-component="Button" data-props="Variant=Primary, Disabled=false">
```

Agent đọc `data-component` để dùng `<Button variant="primary">` có sẵn trong codebase thay vì dựng lại div.

Ghi chú:

- Nhiều agent chạy cùng lúc dùng chung một plugin: process đầu giữ port làm hub, các process sau chuyển request qua hub; hub thoát thì process khác tự tiếp quản.
- Sau khi `npm run build`, process đầu tiên chạy bản mới (agent mới mở, `/mcp` reconnect, hoặc `npm run hub`) sẽ được hub bản cũ nhường port; các process cũ chuyển thành peer, plugin tự nối lại sau ~1.5s. Không cần khởi động lại mọi agent. Các bản build trước tính năng này không biết nhường, nên lần đầu phải tắt chúng.
- Server chỉ nghe `127.0.0.1`/`::1`, từ chối kết nối có `Origin` của trang web, nên trang web không đọc được design.
- Kết nối nằm trong `devAllowedDomains` của manifest: chạy được khi import plugin dạng development, không chạy ở bản publish.
- Dev Mode panel Code (codegen) không có cửa sổ nên không nối MCP được.

## Kiến trúc

```
SceneNode ──normalize──▶ IR ──tree──▶ styled tree (CSS decls) ──┬─ htmlCss  → class + CSS rules
 (Figma API)            (thuần)        css.ts = luật layout      └─ tailwind → CSS decl → class v4
```

| File | Vai trò |
| --- | --- |
| `src/core/normalize.ts` | Module **duy nhất** gọi Figma API: vị trí qua `absoluteTransform`, auto layout, sizing, paint, text segment, variable, SVG export |
| `src/core/ir.ts` | Kiểu IR, không phụ thuộc Figma |
| `src/generators/css.ts` | Luật Figma → CSS (flex, fill/hug, stroke → border/outline, effect...) |
| `src/generators/tailwind.ts` | Dịch khai báo CSS → class Tailwind; không có utility thì fallback `[prop:value]` |
| `src/generators/htmlCss.ts` | Đặt tên class từ tên layer, gộp shorthand |
| `src/core/markup.ts` | AST + printer HTML/JSX (escape, SVG → JSX) |
| `src/plugin/main.ts` | Sandbox: UI mode + codegen mode |
| `src/plugin/bridge.ts` | Sandbox: xử lý request từ MCP (`metadata.ts` outline XML, `variables.ts` token) |
| `src/generators/designContext.ts` | Code tham chiếu cho AI: thuộc tính `data-*`, icon → file asset, gom component/annotation |
| `src/shared/bridge.ts` | Protocol MCP ⇄ plugin (method, params, kết quả) |
| `src/ui/` | UI React (chọn target, code, preview iframe, cảnh báo); `bridge.ts` giữ WebSocket tới MCP; `McpPanel.tsx` panel quản lý agent |
| `mcp/` | MCP server Node: `server.ts` định nghĩa tool, `hub.ts` WebSocket hub/peer + danh sách phiên agent, `agents.ts` vị trí config từng agent, `agentConfig.ts` sửa entry `goapp-figma` trong JSON/TOML |

Thêm framework mới: viết một generator nhận `StyledElement[]` (hoặc đọc thẳng IR), không cần đụng vào `normalize`.

## Test

```bash
npm test          # vitest, test generator bằng IR giả, không cần Figma
npm run typecheck
```

## Giới hạn hiện tại

- Image fill: code luôn tham chiếu file `images/<file>` (không nhúng base64); nút tải ảnh trên thanh tab tải zip. Chế độ CROP xuất thành `cover`, chưa áp opacity/filter của ảnh.
- **Optimize images** (bật mặc định, trong menu ⚙): mỗi file ảnh được thu về 2× kích thước lớn nhất mà design hiển thị nó (không phóng to), nén lại cùng định dạng nên tên file và code không đổi. Áp dụng cho tải ảnh, Export và file ảnh agent nhận qua MCP (`get_design_context`, `generate_code`, `export_project`). Ví dụ ảnh gốc 12 MB hiển thị ~480px → ~95 KB. Tắt đi để giữ ảnh gốc.
- Mask, blend mode chưa hỗ trợ (sẽ hiện cảnh báo).
- Grid auto layout và frame không có auto layout → con được định vị `absolute`.
- Tailwind output nhắm v4 (thang spacing động, `outline-solid`, ...).
