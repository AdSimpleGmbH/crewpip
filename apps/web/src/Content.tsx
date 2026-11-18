import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** No raw HTML or remote images: messages are untrusted operational content. */
export function Content({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    img: ({ alt }) => <span>[Bild: {alt || "ohne Beschreibung"}]</span>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</Markdown></div>;
}
