import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Render public model output as Markdown, without loading remote images or raw HTML. */
export default function MarkdownBody({ text = '' }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      disallowedElements={['img']}
      components={{ a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}
    >{String(text)}</ReactMarkdown>
  </div>;
}
