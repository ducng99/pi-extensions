/**
 * Web extension: registers the webfetch and websearch tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import webfetchTool from "./webfetch/tool";
import websearchTool from "./websearch/tool";

export default function webExtension(pi: ExtensionAPI) {
    webfetchTool(pi);
    websearchTool(pi);
}
