// Превью вложений: первая страница PDF (pdf.js), текст DOCX (mammoth), текст TXT. Библиотеки грузятся по требованию.
import { extOf } from "../../api/files";

export type Thumb = { kind: "img"; src: string } | { kind: "text"; text: string } | { kind: "ext"; ext: string };

async function pdfjs() {
  const lib = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  lib.GlobalWorkerOptions.workerSrc = worker;
  return lib;
}

async function renderPage(page: { getViewport(o: { scale: number }): { width: number; height: number }; render(o: unknown): { promise: Promise<void> } }, width: number) {
  const v1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / v1.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport, canvas }).promise;
  return canvas;
}

export async function makeThumb(file: Blob, name: string): Promise<Thumb> {
  const ext = extOf(name);
  try {
    if (ext === ".pdf") {
      const lib = await pdfjs();
      const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
      const canvas = await renderPage(await doc.getPage(1), 168);
      return { kind: "img", src: canvas.toDataURL("image/png") };
    }
    if (ext === ".docx") {
      const mammoth = (await import("mammoth")).default;
      const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return { kind: "text", text: value.slice(0, 600) };
    }
    if (ext === ".txt") return { kind: "text", text: (await file.text()).slice(0, 600) };
  } catch { /* повреждённый файл — покажем расширение */ }
  return { kind: "ext", ext: ext.replace(".", "") || "файл" };
}

// Полный просмотр: все страницы PDF, DOCX как HTML, TXT как текст
export type Full = { kind: "pdf"; pages: HTMLCanvasElement[] } | { kind: "html"; html: string } | { kind: "text"; text: string } | { kind: "none" };

export async function makeFull(file: Blob, name: string): Promise<Full> {
  const ext = extOf(name);
  if (ext === ".pdf") {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: HTMLCanvasElement[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 50); i++) pages.push(await renderPage(await doc.getPage(i), 1400));
    return { kind: "pdf", pages };
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    return { kind: "html", html: safeHtml((await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value) };
  }
  if (ext === ".txt") return { kind: "text", text: await file.text() };
  return { kind: "none" };
}

// Ссылки из документа — только обычные адреса; обработчики событий убираем
function safeHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      if (a.name.startsWith("on")) el.removeAttribute(a.name);
      if ((a.name === "href" || a.name === "src") && !/^(https?:|mailto:|#|data:image\/)/i.test(a.value.trim())) el.removeAttribute(a.name);
    }
  });
  doc.querySelectorAll("script, iframe, object, embed").forEach((el) => el.remove());
  return doc.body.innerHTML;
}
