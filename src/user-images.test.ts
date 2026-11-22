import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { splitUserImages, UserImageLines } from "./user-images.js";

const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
const tagged = { fg: (token: string, text: string) => `<${token}>${text}</${token}>` } as unknown as Theme;
// eslint-disable-next-line no-control-regex
const stripLinks = (line: string) => line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

const P1 = "C:\\Temp\\pi-clipboard-1.png";
const P2 = "C:\\Temp\\pi-clipboard-2.png";
const RESIZE = "[Image: original 2328x1692, displayed at 2000x1454. Multiply coordinates by 1.16 to map to original image.]";

describe("splitUserImages", () => {
	it("takes references and pi's notes out of the body", () => {
		const text = `look [Image #1]\n\n[Image #1: ${P1} · 2328×1692]\n\n${RESIZE}`;
		expect(splitUserImages(text)).toEqual({
			body: "look [Image #1]",
			images: [{ id: 1, path: P1, size: { width: 2328, height: 1692 }, sent: { width: 2000, height: 1454 } }],
		});
	});

	it("matches resize notes by original size when there are several images", () => {
		const resize2 = "[Image: original 800x600, displayed at 400x300. Multiply coordinates by 2.00 to map to original image.]";
		const text = `a [Image #1] b [Image #2]\n\n[Image #1: ${P1} · 2328×1692]\n[Image #2: ${P2} · 800×600]\n\n${resize2}`;
		const split = splitUserImages(text)!;
		expect(split.images[0]!.sent).toBeUndefined();
		expect(split.images[1]!.sent).toEqual({ width: 400, height: 300 });
	});

	it("keeps notes it cannot place as lines of their own", () => {
		const text = `a [Image #1] b [Image #2]\n\n[Image #1: ${P1}]\n[Image #2: ${P2}]\n\n[Image omitted: could not be resized below the inline image size limit.]`;
		expect(splitUserImages(text)!.images[2]).toEqual({ notSent: "too large" });
	});

	it("handles images without references, the not-attached note and the old format", () => {
		expect(splitUserImages(`what is this\n\n${RESIZE}`)!.images).toEqual([
			{ size: { width: 2328, height: 1692 }, sent: { width: 2000, height: 1454 } },
		]);
		expect(splitUserImages(`x [Image #1]\n\n[Image #1: ${P1} · not attached]`)!.images).toEqual([
			{ id: 1, path: P1, notSent: "model has no image input" },
		]);
		expect(splitUserImages(`x [Image #1]\n\n[Image #1]: ${P1}\n\n${RESIZE}`)).toEqual({
			body: "x [Image #1]",
			images: [{ id: 1, path: P1, size: { width: 2328, height: 1692 }, sent: { width: 2000, height: 1454 } }],
		});
		expect(splitUserImages(`x\n\n[Image converted from image/bmp to image/png.]`)!.images).toEqual([
			{ converted: "bmp → png" },
		]);
	});

	it("leaves ordinary messages and image-only messages alone", () => {
		expect(splitUserImages("hello\n\nworld")).toBeUndefined();
		expect(splitUserImages("see [Image #1: not a trailer] here")).toBeUndefined();
		expect(splitUserImages(RESIZE)).toBeUndefined();
	});
});

describe("UserImageLines", () => {
	it("draws the tool-group rails with size and resize", () => {
		const view = new UserImageLines(
			[
				{ id: 1, path: P1, size: { width: 2328, height: 1692 }, sent: { width: 2000, height: 1454 } },
				{ id: 2, path: P2, size: { width: 800, height: 600 } },
			],
			() => theme,
			() => true,
		);
		expect(view.render(80).map(stripLinks)).toEqual([
			"  ├ Image #1 · 2328×1692 → 2000×1454",
			"  └ Image #2 · 800×600",
		]);
	});

	it("links the name to the file while it exists", () => {
		const [line] = new UserImageLines([{ id: 1, path: "/tmp/a.png" }], () => theme, () => true).render(80);
		expect(line).toContain("\x1b]8;;file:///");
		const [gone] = new UserImageLines([{ id: 1, path: "/tmp/a.png" }], () => tagged, () => false).render(200);
		expect(gone).not.toContain("\x1b]8;;");
		expect(gone).toContain("<warning> · file removed</warning>");
	});

	it("shows why an image was not sent, in the warning color", () => {
		const [line] = new UserImageLines([{ id: 3, notSent: "model has no image input" }], () => tagged).render(200);
		expect(line).toContain("<warning> · not sent · model has no image input</warning>");
	});

	it("truncates to the width", () => {
		const [line] = new UserImageLines([{ id: 1, size: { width: 2328, height: 1692 } }], () => theme).render(12);
		// eslint-disable-next-line no-control-regex
		expect(line!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("  └ Image #…");
	});
});
