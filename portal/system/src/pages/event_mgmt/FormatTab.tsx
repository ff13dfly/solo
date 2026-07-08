import React from 'react';

function Row({ cols, widths, header, dim }: {
  cols: React.ReactNode[];
  widths: string;
  header?: boolean;
  dim?: boolean;
}) {
  return (
    <div className={`grid px-4 items-start ${header ? 'py-2 bg-bg-secondary border-b-2 border-border' : `py-2.5 border-b border-border last:border-b-0 ${dim ? 'bg-white/[0.01]' : ''}`}`}
      style={{ gridTemplateColumns: widths }}>
      {cols.map((c, i) => (
        <div key={i} className={header ? 'text-[10px] font-bold text-accent uppercase tracking-wider' : 'text-[12px]'}>{c}</div>
      ))}
    </div>
  );
}

function Table({ headers, widths, rows }: {
  headers: string[];
  widths: string;
  rows: React.ReactNode[][];
}) {
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <Row cols={headers} widths={widths} header />
      {rows.map((r, i) => <Row key={i} cols={r} widths={widths} dim={i % 2 !== 0} />)}
    </div>
  );
}

const M  = ({ c }: { c: string }) => <span className="font-mono text-[11px] text-accent">{c}</span>;
const MG = ({ c }: { c: string }) => <span className="font-mono text-[11px] text-text-secondary">{c}</span>;
const T  = ({ c }: { c: string }) => <span className="font-mono text-[11px] text-warning/70">{c}</span>;

export default function FormatTab() {

  const ENVELOPE_EXAMPLE =
`// EVENT:WORKFLOW:RESULT 里的一条消息 —— 所有字段值均为字符串（Redis Stream 约束）
{
  "type":       "workflow.run.completed",   // 发生了什么。点分层级，生产者定义
  "source":     "orchestrator",             // 哪个服务发的。Router 认证，不可伪造
  "actor":      "cron:daily-report",        // 谁/什么导致的（provenance），见下方取值
  "trace_id":   "a3f9c1d2b4e50f61",         // 8字节 hex，贯穿调用链
  "event_id":   "b7e20f11d3c49a82",         // 8字节 hex，每条唯一，消费侧幂等 key
  "emitted_at": "1748880005432",            // String(Date.now())，⚠ 字符串非数字
  "payload":    "{\\"workflow_id\\":\\"wf-daily-report\\",\\"status\\":\\"completed\\"}"
  //            ↑ 业务数据，JSON.stringify 后的字符串，消费侧自动 parse。
  //              只装"这件事的数据"，不装触发来源、不装调度信息（那些在 actor / Schedule）。
}`;

  const SCHEDULE_EXAMPLE =
`// NEXUS:SCHEDULE:DEF:daily-report —— Redis JSON 文档（与上面的事件是两回事）
{
  "schedule_id":   "daily-report",
  "fire_at":       1748880000000,   // 下次触发绝对时刻 ms（= ZSet score）
  "recurrence_ms": 86400000,        // ★ 重复性只存在这里。null = 单次，> 0 = 每隔 N ms
  "action": { "kind": "run_command", "workflow_id": "wf-daily-report" },
  "enabled":       true,
  "last_fired_at": 1748793600000
}
// 触发后 scheduler：执行 action + （recurrence_ms != null）更新 fire_at 重新入 ZSet。
// "会不会再跑"是 Schedule 的属性，事件永远不携带、也无从携带。`;

  const CONSUMER_NOTE =
`// 消费侧（Matcher + Nexus Consumer）对 { / [ 开头的字段自动 JSON.parse
const event = parseEntry(message);
// event.payload → { workflow_id, status }

// 谁触发的？看 event.actor，不要去翻 payload：
const fromCron = event.actor.startsWith("cron:");   // 定时触发
// 要知道这个 cron 会不会再跑？拿 schedule_id 反查 Schedule 实体：
const id = event.actor.slice(5);                     // "daily-report"
// → nexus.schedule.get(id) → recurrence_ms != null ? 循环 : 单次`;

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-10">

      {/* ── 0. 三个正交概念（先立心智模型）── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">事件 = 一个已发生的事实</div>
        <div className="text-[11px] text-text-secondary mb-3">
          三件事各有归属，绝不混在一起。看不懂格式，多半是把下面三列搅成了一团。
        </div>
        <Table
          headers={['想知道什么', '答案在哪', '为什么不在事件里']}
          widths="1.6fr 2fr 3fr"
          rows={[
            ['发生了什么',      <>事件 <M c="type" /> + <M c="payload" /></>,                  '这就是事件本身'],
            ['谁/什么导致的',   <>事件 <M c="actor" /> 字段（信封层）</>,                       'provenance 是一等信封字段，不需翻 payload'],
            ['以后还跑不跑',    <>Schedule 实体 <M c="recurrence_ms" /></>,                     '事件是"过去式事实"，没有"未来会不会再发生"的概念'],
          ]}
        />
        <div className="mt-2 text-[10px] text-text-secondary leading-relaxed">
          ⚠ 单次任务和循环任务写出的事件信封<strong className="text-text-primary">完全一样</strong>。
          "是否定时触发"看 <span className="font-mono text-accent">actor</span> 前缀；
          "是否会再次触发"必须拿 schedule_id 反查 Schedule —— 事件层查不到，这是设计如此，不是缺陷。
        </div>
      </section>

      {/* ── 1. 标准信封 ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-3">1 · 标准信封（Event Envelope）</div>
        <pre className="bg-bg-primary border border-border rounded-md p-4 text-[12px] font-mono text-text-secondary leading-relaxed overflow-x-auto mb-4">
          {ENVELOPE_EXAMPLE}
        </pre>
        <div className="text-[11px] font-semibold text-text-primary mb-2">actor 取值规则（= provenance，由生产者声明，Router 盖戳）</div>
        <Table
          headers={['actor 值', '触发来源', '何时']}
          widths="1.6fr 1.8fr 3fr"
          rows={[
            [<MG c="uid-abc123" />,           '用户直接调用',    <>同步 <M c="workflow.run" />，actor = 登录 UID</>],
            [<MG c="cron:{schedule_id}" />,   'Nexus Scheduler', '定时任务触发，scheduler 经 event.emit 声明'],
            [<MG c="event:{stream}" />,       '事件链触发',      '被另一条事件匹配触发的 workflow'],
            [<MG c="{bot-name}" />,           'bot 主动发',      'relay bot 主动 event.emit 且未声明更具体来源'],
            [<MG c="system" />,               '兜底',            '无任何触发上下文'],
          ]}
        />
        <div className="mt-2 text-[10px] text-text-secondary">
          实现：<span className="font-mono">event.emit</span> 允许调用方声明 <span className="font-mono">actor</span>（Router 经 <span className="font-mono">trustEventActor</span> 采信），
          <span className="font-mono">source</span> 始终由 Router 认证不可伪造。Runner 写结果事件时 <span className="font-mono">actor = triggerSource</span>（cron/event）或 <span className="font-mono">callerUid</span>（sync）。
        </div>
      </section>

      {/* ── 2. Schedule 实体（重复性的唯一归属）── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">2 · 定时任务实体（Schedule）</div>
        <div className="text-[11px] text-text-secondary mb-3">
          与事件是两个独立对象。重复性只存在这里。存于 <span className="font-mono">NEXUS:SCHEDULE:DEF:{'{id}'}</span>，触发时间索引在 ZSet <span className="font-mono">NEXUS:SCHEDULE</span>（score = fire_at）。
        </div>
        <pre className="bg-bg-primary border border-border rounded-md p-4 text-[12px] font-mono text-text-secondary leading-relaxed overflow-x-auto mb-4">
          {SCHEDULE_EXAMPLE}
        </pre>
        <Table
          headers={['action.kind', '必填字段', '触发结果']}
          widths="1.2fr 2fr 3fr"
          rows={[
            [<T c="run_command" />, <M c="workflow_id" />,                  '推 run-command 进 orchestrator run-queue（点对点，不产生事件）'],
            [<T c="emit_event" />,  <><M c="stream" /> + <M c="type" /></>, '经 relay → Router → xAdd 写入目标流（actor = cron:{id}，广播）'],
          ]}
        />
        <div className="mt-2 text-[10px] text-text-secondary">
          注意：<span className="font-mono">run_command</span>（最常见）触发 workflow 时<strong className="text-text-primary">不发事件</strong>——直接进 run-queue。
          事件只在 workflow 跑完由 runner 产生，或显式 <span className="font-mono">emit_event</span> 才有。
        </div>
      </section>

      {/* ── 3. 内置 Streams ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">3 · 系统内置 Streams</div>
        <div className="text-[11px] text-text-secondary mb-3">由 Orchestrator Runner 自动写入。自定义命名建议：<span className="font-mono">EVENT:{'<DOMAIN>'}:{'<VERB>'}</span></div>
        <Table
          headers={['STREAM KEY', 'type', 'payload 字段（业务数据）']}
          widths="2.5fr 2fr 3fr"
          rows={[
            [<M c="EVENT:WORKFLOW:STATUS" />, <MG c="workflow.run.failed" />,    <MG c="workflow_id, status, failed_step, error" />],
            [<M c="EVENT:WORKFLOW:RESULT" />, <MG c="workflow.run.completed" />, <MG c="workflow_id, status" />],
          ]}
        />
      </section>

      {/* ── 4. 消费侧与路由 ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-3">4 · 消费侧行为与路由</div>
        <pre className="bg-bg-primary border border-border rounded-md p-4 text-[12px] font-mono text-text-secondary leading-relaxed overflow-x-auto mb-4">
          {CONSUMER_NOTE}
        </pre>
        <div className="flex flex-col gap-2">
          {([
            { from: 'Orchestrator Runner',   arrow: 'workflow 跑完 → xAdd(stream, envelope)', to: 'Redis Stream',               cls: 'border-accent/30' },
            { from: 'Nexus Scheduler',       arrow: 'emit_event → relay → Router → xAdd',     to: 'Redis Stream',               cls: 'border-accent/20' },
            { from: 'Nexus Stream Consumer', arrow: '匹配 Agent eventSubscriptions',          to: 'notification.send(agentId)', cls: 'border-success/30' },
            { from: 'Orchestrator Matcher',  arrow: '匹配 Workflow event_subscriptions',      to: 'run.enqueue(workflowId)',    cls: 'border-warning/30' },
          ] as const).map(r => (
            <div key={r.from} className={`grid items-center border ${r.cls} rounded-md px-4 py-2.5 bg-white/[0.01] text-[11px]`}
              style={{ gridTemplateColumns: '12rem 1fr 13rem' }}>
              <span className="font-mono text-accent">{r.from}</span>
              <span className="text-text-secondary">→ {r.arrow}</span>
              <span className="font-mono text-text-secondary text-right">{r.to}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 5. 已知偏差 ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">5 · 已知偏差 / 遗留问题</div>
        <div className="text-[11px] text-text-secondary mb-3">实现与协议设计（event.md）尚存以下差异，开发时需知晓。</div>
        <Table
          headers={['问题', '影响', '建议处理']}
          widths="2fr 2fr 3fr"
          rows={[
            [
              <><span className="font-mono text-warning text-[11px]">recurrence_ms</span><span className="text-text-secondary text-[11px]"> vs cron 表达式</span></>,
              '只能固定步长，不能精确到"每天 02:00"',
              '如需绝对时刻，改 cron 表达式 + 解析器',
            ],
            [
              <span className="text-text-secondary text-[11px]">runner 直写 xAdd（绕过 Router）</span>,
              '不经 Router 认证/白名单，格式已标准化',
              '长期改为响应挂 _event；当前可接受',
            ],
            [
              <span className="text-text-secondary text-[11px]">流 trim（D10）未实现</span>,
              'Redis Stream 长期不裁剪无限增长',
              <span className="font-mono text-[11px]">xAdd MAXLEN ~ 10000</span>,
            ],
          ]}
        />
      </section>

    </div>
  );
}
