import { beforeEach, describe, expect, it, vi } from "vitest";
import SharedDocumentPage, { generateMetadata } from "./page";
import { fetchSharedDocument } from "@/lib/shared-document";
import { notFound } from "next/navigation";

vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }) }));
vi.mock("@/components/editor/shared-document-page-client", () => ({ SharedDocumentPageClient: () => null }));
vi.mock("@/lib/shared-document", () => ({
  fetchSharedDocument: vi.fn(),
  resolveAppOrigin: vi.fn(async () => "https://app.example"),
  normalizeSharedDocumentTitle: (title: string) => title,
  buildSharedDocumentPreview: (content: string) => content,
}));
const params = () => ({ params: Promise.resolve({ id: "doc", token: "token" }) });
beforeEach(() => vi.clearAllMocks());

describe("shared page failure policy", () => {
  it("uses notFound only when access is invalid or revoked", async () => {
    vi.mocked(fetchSharedDocument).mockResolvedValue({ status: "not_found" });
    await expect(SharedDocumentPage(params())).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("preserves an upstream outage as an error instead of claiming the document is missing", async () => {
    vi.mocked(fetchSharedDocument).mockResolvedValue({ status: "unavailable" });
    await expect(SharedDocumentPage(params())).rejects.toThrow("temporarily unavailable");
    expect(notFound).not.toHaveBeenCalled();
    expect(await generateMetadata(params())).toMatchObject({ title: "Shared document | Mushpot" });
  });

  it("passes a validated document to the renderer", async () => {
    const document = { title: "Title", content: "Body", updated_at: "2026-09-21T00:00:00Z" };
    vi.mocked(fetchSharedDocument).mockResolvedValue({ status: "success", data: document });
    expect((await SharedDocumentPage(params())).props).toMatchObject({ title: "Title", content: "Body" });
    expect(notFound).not.toHaveBeenCalled();
  });
});
