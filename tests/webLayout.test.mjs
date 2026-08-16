import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webCss = readFileSync("src/renderer/src/web/web.css", "utf8");
const webSidebar = readFileSync("src/renderer/src/web/WebSidebar.tsx", "utf8");
const webHeader = readFileSync("src/renderer/src/web/WebHeader.tsx", "utf8");
const webChatApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const webComposer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const webHtml = readFileSync("src/renderer/web.html", "utf8");

test("Web shell keeps sidebar and chat pane in a horizontal split", () => {
	assert.match(
		webCss,
		/\.app\.wechat-shell\s*\{[\s\S]*?flex-direction:\s*row;/,
		"the desktop shell defaults to a vertical layout, so Web must explicitly restore the horizontal split",
	);
	assert.match(
		webCss,
		/\.app\.wechat-shell\s*>\s*\.chat-list-pane\s*\{[\s\S]*?flex:\s*0\s+0\s+280px;[\s\S]*?width:\s*280px;/,
		"the Web sidebar needs a stable width or it consumes the chat pane",
	);
	assert.match(
		webCss,
		/\.app\.wechat-shell\s*>\s*\.chat-pane\s*\{[\s\S]*?flex:\s*1\s+1\s+0;/,
		"the chat pane must own the remaining horizontal space",
	);
});

test("Web project rows can collapse after the active session is revealed", () => {
	assert.match(webSidebar, /useEffect\(\(\) => \{/);
	assert.doesNotMatch(
		webSidebar,
		/expandedProjects\.has\(project\.id\) \|\| project\.id === activeSessionProjectId/,
		"the active project must not be forced open on every render",
	);
	assert.match(webSidebar, /const expanded = searching \|\| expandedProjects\.has\(project\.id\)/);
});

test("Web model picker supports search and mobile header wrapping", () => {
	assert.match(webHeader, /<CommandInput placeholder=\{t\("web\.modelSearch"\)\}/);
	assert.match(webHeader, /CommandEmpty>\{t\("web\.modelEmpty"\)\}/);
	assert.match(webHeader, /chat-header flex min-w-0 flex-wrap/);
});

test("Web header mounts context checkboxes before the model picker", () => {
	const checksIndex = webHeader.indexOf("<WebContextChecks");
	const pickerIndex = webHeader.indexOf("<ModelPicker");
	assert.ok(checksIndex >= 0, "WebHeader must mount WebContextChecks");
	assert.ok(pickerIndex > checksIndex, "context checks must sit left of the model picker");
	const checks = readFileSync("src/renderer/src/web/WebContextChecks.tsx", "utf8");
	assert.match(checks, /applyLocalSwitch/);
	assert.match(checks, /sendContextControllerCommand/);
	assert.match(checks, /pendingRef/);
});

test("Mobile Web keeps chat full-screen and opens the project tree as a drawer", () => {
	assert.match(webChatApp, /mobileSidebarOpen/);
	assert.match(webChatApp, /onOpenSidebar/);
	assert.match(webSidebar, /mobile-sidebar-backdrop/);
	assert.match(webSidebar, /mobile-open/);
	assert.match(webSidebar, /onDeleteProject/);
});

test("Web starts with no selected session and exposes a scroll-to-bottom action", () => {
	assert.doesNotMatch(webChatApp, /setActiveSessionId\(next\.sessions\[0\]\?\.id \?\? ""\)/);
	assert.match(webChatApp, /setActiveSessionId\(""\)/);
	assert.match(webTimeline, /scroll-to-bottom|ScrollDown|scrollToBottom/);
});

test("Web tool cards stay compact and keep a visible settled status", () => {
	assert.match(webTimeline, /tool-card inline-flex w-fit max-w-full/);
	assert.match(webTimeline, /t\("tool\.statusDone"\)/);
	assert.match(webTimeline, /formatToolPreview/);
});

test("Web timeline does not double-space tool and thinking steps", () => {
	assert.match(webTimeline, /message-list flex flex-col gap-2 p-4/);
	assert.match(webTimeline, /<div key=\{message\.id\} className="mt-0">/);
	assert.doesNotMatch(webTimeline, /user-turn group\/user mb-4/);
	assert.match(webTimeline, /<TimelineMarker kind="thinking" tone="neutral" contentClassName="pb-0">/);
	assert.match(webTimeline, /<TimelineMarker[\s\S]*?kind="tool"[\s\S]*?contentClassName="pb-0"/);
	assert.match(webTimeline, /flex min-h-6 max-w-full items-center px-2 py-0\.5/);
});

test("Project actions are sibling buttons instead of nested controls", () => {
	assert.match(webSidebar, /project-row-actions[\s\S]*?<Button/);
	assert.doesNotMatch(webSidebar, /project-row-actions[\s\S]*?<span[\s\S]*?role="button"/);
});

test("Web shell tracks the visual viewport so mobile chrome cannot crop the header or composer", () => {
	assert.match(webChatApp, /visualViewport/);
	assert.match(webChatApp, /--web-viewport-height/);
	assert.match(webChatApp, /--web-viewport-width/);
	assert.match(webChatApp, /--web-viewport-offset-left/);
	assert.match(webChatApp, /--web-viewport-offset-top/);
	assert.match(webChatApp, /offsetLeft/);
	assert.match(webChatApp, /offsetTop/);
	assert.match(webCss, /position:\s*fixed/);
	assert.match(webCss, /--web-viewport-width/);
	assert.match(webCss, /--web-viewport-offset-left/);
	assert.match(webCss, /--web-viewport-offset-top/);
	assert.match(webCss, /height:\s*100dvh/);
	assert.match(webCss, /--web-viewport-height/);
	assert.match(webCss, /safe-area-inset-top/);
	assert.match(webCss, /safe-area-inset-bottom/);
	assert.match(webCss, /@media\s*\(max-width:\s*900px\)/);
	assert.match(webCss, /\.chat-list-pane[\s\S]*height:\s*var\(--web-viewport-height/);
	assert.match(webCss, /\.mobile-sidebar-backdrop[\s\S]*height:\s*var\(--web-viewport-height/);
	assert.match(webComposer, /composer[\s\S]*shrink-0/);
	assert.match(webCss, /\.app\.wechat-shell\s*>\s*\.chat-pane\s*>\s*\.composer[\s\S]*margin-bottom:\s*0/);
	assert.match(webHtml, /viewport-fit=cover/);
});

test("Web entry wraps the app in TooltipProvider for context-check hints", () => {
	const webMain = readFileSync("src/renderer/src/web-main.tsx", "utf8");
	assert.match(webMain, /TooltipProvider/);
	assert.match(webMain, /<WebChatApp/);
});
