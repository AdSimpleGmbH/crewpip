import { useBoardLanguage } from "./language.tsx";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** No raw HTML or remote images: messages are untrusted operational content. */
export function Content({ text }: { text: string }) {
  const { ui } = useBoardLanguage();
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    img: ({ alt }) => <span>{ui.image} {alt || ui.noDescription}]</span>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</Markdown></div>;
}
