import type { Message } from "../../types";

interface ListMessageProps {
  message: Message;
}

/**
 * Renders a read/list result (an `items` array) inline in the chat — the counterpart to a
 * write's "✅ 已成功执行" line. Driven by `message.payload.items`; each item shows a title
 * (name/title/label) and, if present, its id.
 */
export function ListMessage({ message }: ListMessageProps) {
  const items: any[] = Array.isArray(message.payload?.items) ? message.payload.items : [];

  return (
    <div
      data-test="result-list"
      className="max-w-[80%] rounded-lg bg-white text-black p-2 relative break-words"
    >
      {message.content && (
        <div className="px-1 pb-1 text-xs text-gray-500">{message.content}</div>
      )}

      {items.length === 0 ? (
        <div className="px-2 py-3 text-sm text-gray-400">（无结果）</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item, i) => {
            const title =
              item?.name || item?.title || item?.label || item?.data?.name || JSON.stringify(item);
            const sub = item?.id || item?.data?.id;
            return (
              <li
                key={item?.id ?? i}
                data-test="result-item"
                className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
              >
                <div className="text-black">{title}</div>
                {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
