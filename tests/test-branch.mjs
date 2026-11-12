/**
 * dsh-chat-tree —— 「接管新分支」回归测试。
 *
 * 【导读】
 * 干嘛的：把**真实踩过坑的那几个会话**倒带到"分支刚被造出来"的那一刻，
 * 让 host 半的 `adoptBranch` 真的跑一遍，看它有没有把坑填上。
 *
 * 为什么这样测：这两个 bug 都只在"分支诞生的一瞬间"表现出来，
 * 事后看日志只能看到结果。把盘上真实日志切回那一刻重放，是不开浏览器
 * 能做到的最接近真事的测法。
 *
 * 数据流一句话：
 *   读真实会话日志 → 切到 `session/end-seed{inherited}` 之前（= 继承前缀）
 *   → 按这段前缀折出"当时队列里有什么" → 造一个假 agent
 *   → 调 adoptBranch → 断言队列被清空 / sidecar 被写对。
 *
 * ⚠️ 两条数据安全规矩（踩过 / 差点踩）：
 *   · **不把整盘日志留在内存里**。本机 1000+ 个会话、解压后 2.6GB，一次全收是
 *     4GB 默认堆下必崩。这里先扫一遍只记"哪些是分支"，断言时**按 id 重读**，
 *     同一时刻内存里最多一份日志。
 *   · **一个字节都不读真实旁车**。那些 sidecar 属于用户正在跑的会话，开读句柄会让
 *     dsh-claude 的原子 rename EPERM、当场打死那一轮（AGENTS §4.1）。断言 B/B3 用的
 *     父 sidecar 在**临时 home 里现造**一份同形状的（binding + anchors + activities），
 *     真实 home 只用来读会话日志（那是 dsh 自己的只读 API 数据，不是旁车）。
 *
 * 阅读顺序：
 *   第1步  准备：读盘、临时 DSH_HOME
 *   第2步  倒带：把一个分支还原成"刚出生"的样子
 *   第3步  断言 A —— 清掉继承来的待办（所有 provider）
 *   第4步  断言 B —— 接上外部引擎的记忆（只有 dsh-claude 这类）
 *   第5步  断言 C —— 不该动的时候一个字节都不动
 *
 * 跑法：
 *   DSH_HOME_REAL='E:/Programs/deepseek-harness/home' node tests/test-branch.mjs
 *
 * @module test-branch
 */

import { check, report } from './test-kit.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// 注意顺序：先记下真实 home，后面才把 DSH_HOME 改指到临时目录。
// 默认值和别的脚本保持一致。原来默认 `~/.dsh`，在这台机器上找不到 →
// **整份脚本静默跳过**，而它恰好是唯一一个真跑 graft 的测试。
const REAL_HOME = process.env.DSH_HOME_REAL || process.env.DSH_HOME || 'E:/Programs/deepseek-harness/home'
const SESSIONS = path.join(REAL_HOME, 'sessions')


/**
 * 解一个 session 文件。v3 是**多 frame 拼接**的 zstd，Node 的 zstdDecompressSync
 * 只解第一个就停且不报错，所以自己扫 frame 头逐个解。
 * @param file - 绝对路径
 * @returns 事件数组
 */
function readSession(file) {
	const buffer = fs.readFileSync(file)
	const parts = []
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer.readUInt32LE(i) !== 0xfd2fb528) continue
		try {
			parts.push(zlib.zstdDecompressSync(buffer.subarray(i)))
		} catch {
			/* 不是真的 frame 头 */
		}
	}
	return Buffer.concat(parts)
		.toString('utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return null
			}
		})
		.filter(Boolean)
}

/** sidecar 文件名就是会话 id 原样 base64url。 */
const sidecarName = (sessionId) => `${Buffer.from(sessionId).toString('base64url')}.json`

/** 一条消息的纯文本，用来在断言里认人。 */
const say = (message) => (message.content || []).map((part) => part.text || `<${part.type}>`).join('')

// ===== 第 1 步：准备 =====

if (!fs.existsSync(SESSIONS)) {
	console.log(`跳过：找不到 ${SESSIONS}（设 DSH_HOME_REAL 指向真实 home 再跑）`)
	process.exit(0)
}

/**
 * 只记 id → 文件，不记事件。
 * @type {Map<string, string>}
 */
const files = new Map()
/** 盘上全部会话 id（血缘表要把它们都登记成"没有父亲"，好让 graft 找到顶）。 */
const allIds = []
/** 真是分支（header.isSeeded 且带 inherited end-seed）的会话 id。 */
const branchIds = []

for (const bucket of fs.readdirSync(SESSIONS)) {
	const bucketDir = path.join(SESSIONS, bucket)
	if (!fs.statSync(bucketDir).isDirectory()) continue
	for (const dir of fs.readdirSync(bucketDir)) {
		// dsh 0.2 写 v4（事件格式和 v3 一样，只是文件名换了）；0.1.5 的 v3 文件在被 0.2 打开过之后
		// 会多出一份 v4，两份都在时以新的为准 —— 宿主自己也只认最新那一代。
		const file = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'].map((name) => path.join(bucketDir, dir, name)).find((candidate) => fs.existsSync(candidate))
		if (file === undefined) continue
		files.set(dir, file)
		allIds.push(dir)
		// ⚠️ 这一步只是判定"是不是分支"，事件读完就丢。别把 `events` 存进 Map ——
		//    那正是上一版 4GB 堆爆掉的原因（全盘解压后 2.6GB 常驻）。
		const events = readSession(file)
		const header = events.find((event) => event.type === 'session' && event.seq === undefined) || {}
		if (header.isSeeded !== true) continue
		const seeded = events.some((event) => event.type === 'session/end-seed' && (event.data || {}).inherited === true)
		if (seeded) branchIds.push(dir)
	}
}

// 临时 home：graft 会往这里写，绝不碰真实的那份
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-tree-branch-'))
process.env.DSH_HOME = home
const sidecarDir = path.join(home, 'plugins', 'dsh-claude', 'sessions')
fs.mkdirSync(sidecarDir, { recursive: true })

const host = await import(new URL('../index.js', import.meta.url))
const { adoptBranch, lineage } = host.__test
// ⚠️ `agents` 不能省。graft 是 fail-closed 的：问不出会话状态就当它在跑、拒绝读旁车。
//    少了这张表，接管会**静悄悄地什么都不干**（上面那句 statusProbe 会返回 unknown）。
//    `status: 'idle'` 就是离线测试里的常态：没有任何一轮在跑。
const ctx = {
	logger: { info() {}, warn() {} },
	agents: { get: () => ({ status: 'idle' }) },
}

// ===== 第 2 步：倒带 —— 把一个分支还原成"刚出生"的样子 =====

/**
 * 队列的标准折叠：`agent/inbox/spliced` 就是对两个待办列表做 splice。
 * 这不是我发明的规则，是日志里这类事件的字面语义
 * （`{target, start, removedCount, inserted}`）。
 * @param events - 要折叠的事件
 * @returns {'next-turn': [...], 'next-step': [...]}
 */
function foldInbox(events) {
	const state = { 'next-turn': [], 'next-step': [] }
	for (const event of events) {
		if (event.type !== 'agent/inbox/spliced') continue
		const data = event.data || {}
		const list = state[data.target]
		if (list === undefined) continue
		list.splice(data.start || 0, data.removedCount || 0, ...(data.inserted || []))
	}
	return state
}

/**
 * 把一个**真实的分支会话**倒带到"刚被 fork 出来、还没跑任何一轮"的那一刻，
 * 造出一个 host 半看得懂的假 agent。
 *
 * 继承前缀的终点就是这条分支自己的 `session/end-seed {inherited:true}`——
 * 取**最后一个**，因为分支的分支会把祖先的那条也继承下来。
 * @param id - 会话 id（含 `session-` 前缀）
 * @param events - 这条会话的完整事件
 * @returns 假 agent，或 undefined（不是分支）
 */
function buildAgent(id, events) {
	const seeds = events.filter((event) => event.type === 'session/end-seed' && (event.data || {}).inherited === true)
	if (seeds.length === 0) return undefined
	const inheritedEventCount = seeds[seeds.length - 1].seq
	const prefix = events.filter((event) => event.seq < inheritedEventCount)

	// 父亲是谁：日志第一条就是 header 记录（`{type:'session', parentSession, isSeeded, …}`），
	// 直接用它，别去猜。
	const header = events.find((event) => event.type === 'session' && event.seq === undefined) || {}
	const parentSession = header.parentSession

	const inbox = foldInbox(prefix)
	return {
		id,
		inbox: {
			get nextTurn() {
				return inbox['next-turn']
			},
			get nextStep() {
				return inbox['next-step']
			},
			get hasPending() {
				return inbox['next-turn'].length > 0 || inbox['next-step'].length > 0
			},
			// 照着宿主 ReactLoopInbox.remove 的语义：删掉返回 true，本来就不在返回 false
			remove(messageId) {
				for (const target of ['next-turn', 'next-step']) {
					const at = inbox[target].findIndex((message) => message.id === messageId)
					if (at >= 0) {
						inbox[target].splice(at, 1)
						return true
					}
				}
				return false
			},
		},
		session: {
			id,
			inheritedEventCount,
			header: { isSeeded: true, parentSession },
			// ⚠️ 真实运行时，`session/end-seed` 就写在 seq == inheritedEventCount 上，
			//    也就是**创建那一刻这条分支已经有一条自有事件了**。
			//    上一版靠"还没有自有事件"来判断"刚出生"，正是栽在这里。
			//    所以这里如实带上它，别把测试造得比现实干净。
			snapshotEvents: () => [...prefix, { seq: inheritedEventCount, type: 'session/end-seed', data: { inherited: true } }],
			isOwnSeq: (seq) => seq >= inheritedEventCount && seq < inheritedEventCount + 1,
		},
	}
}

/**
 * 按 id 重读并倒带。**一次只在内存里放一份** —— 这是不再 OOM 的关键。
 * @param id - 会话 id
 * @returns 假 agent
 */
function rewind(id) {
	const file = files.get(id)
	return file === undefined ? undefined : buildAgent(id, readSession(file))
}

// 血缘表：host 半靠它往上找锚点。真实运行时由 collect() 刷新，这里手工喂。
for (const id of allIds) if (!lineage.has(id)) lineage.set(id, undefined)
console.log(`读到 ${allIds.length} 个真实会话，其中 ${branchIds.length} 个是分支`)
check(branchIds.length > 0, '盘上至少要有一个分支才测得动')

// ===== 第 3 步：断言 A —— 清掉继承来的待办 =====

// 这是 John 这次踩的坑：他在「加上22是多少」后面开岔路问「-1呢？」，
// 结果算成了 22+44-1 —— 因为「加上44呢？」作为一条没跑过的待办被继承了过去。
let dirty = 0
/** id → 父亲会话 id（顺手记下，后面挑 claudeCase 用，免得再读一遍）。 */
const parentOf = new Map()
console.log('')
for (const id of branchIds) {
	const agent = rewind(id)
	const parentId = agent.session.header.parentSession
	parentOf.set(id, parentId)
	lineage.set(id, parentId)
	const before = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(say)
	if (agent.inbox.hasPending) {
		dirty += 1
		console.log(`   ${id.slice(8, 20)} 继承了 ${JSON.stringify(before)}`)
	}
	adoptBranch(ctx, agent)
	check(
		agent.inbox.hasPending === false,
		`${id.slice(8, 20)} 接管后队列必须是空的，实际还剩 ${JSON.stringify([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(say))}（原有 ${JSON.stringify(before)}）`,
	)
}
console.log(`第3步：${dirty} 个分支出生时带着继承来的待办`)
check(dirty > 0, '盘上至少要有一个"脏"分支，否则这条断言测了个寂寞')
console.log(`断言 A：${branchIds.length} 个分支接管后队列全部为空 —— 不会再自动重跑旧问题`)

// ===== 第 4 步：断言 B —— 接上外部引擎的记忆 =====
//
// 只有 dsh-claude 那种"把对话托管给外部引擎"的才需要。
// ⚠️ 父 sidecar 在**临时 home 里现造**：真实那几份属于用户正在跑的会话，
//    开读句柄会让 dsh-claude 的原子 rename EPERM、当场打死那一轮（AGENTS §4.1）。
//    会话日志是 dsh 自己的只读数据，可以读；旁车不行。
const claudeCaseId = branchIds.find((id) => parentOf.get(id) !== undefined) || branchIds[0]
const claudeCase = rewind(claudeCaseId)
const forkTurn = host.__test.forkTurnOf(claudeCase.session)

/**
 * 造一份和 dsh-claude 同形状的旁车（binding + anchors + activities + pending）。
 * @param parentId - 父会话 id
 * @param turn - 岔路点轮次
 * @returns 造出来的文档
 */
function writeParentSidecar(parentId, turn) {
	const doc = {
		schemaVersion: 1,
		revision: 0,
		activities: Array.from({ length: turn + 2 }, (_, i) => ({ turn: i + 1 })),
		binding: { claudeSessionId: 'claude-fake-1', cwd: '/w' },
		rewind: {
			ranges: [],
			anchors: Array.from({ length: turn + 2 }, (_, i) => ({ turn: i + 1, uuid: `u${i + 1}` })),
			snapshots: Array.from({ length: turn + 2 }, (_, i) => ({ turn: i + 1, uuid: `s${i + 1}` })),
			pending: {},
		},
	}
	fs.writeFileSync(path.join(sidecarDir, sidecarName(parentId)), `${JSON.stringify(doc)}\n`)
	return doc
}

let claudeParentId
if (forkTurn === undefined) {
	console.log('\n断言 B：跳过（挑不出带继承轮的分支）')
} else {
	// 有真实父亲就用它；桌面版 0.2.2 的 fork 不写 parentSession，这时造一个。
	claudeParentId = typeof claudeCase.session.header.parentSession === 'string'
		? claudeCase.session.header.parentSession
		: 'session-fake-parent'
	claudeCase.session.header.parentSession = claudeParentId
	lineage.set(claudeCase.id, claudeParentId)
	const parentDocument = writeParentSidecar(claudeParentId, forkTurn)

	// 这个分支在上面已经被接管过一次了（那时还没有父 sidecar，所以什么都没写）。
	const childFile = path.join(sidecarDir, sidecarName(claudeCase.id))
	fs.rmSync(childFile, { force: true })
	adoptBranch(ctx, claudeCase)

	check(fs.existsSync(childFile), `${claudeCase.id.slice(8, 20)} 应当被写出 sidecar（没写 = 接管压根没跑）`)
	if (!fs.existsSync(childFile)) {
		console.log('       后面几条依赖它，跳过')
	} else {
		const written = JSON.parse(fs.readFileSync(childFile, 'utf8'))
		const expected = parentDocument.rewind.anchors.find((item) => item.turn === forkTurn)
		console.log(`\n断言 B：${claudeCase.id.slice(8, 20)} 岔路在 turn${forkTurn}`)
		check(written.binding.claudeSessionId === parentDocument.binding.claudeSessionId, '必须绑到父分支同一个外部会话（这是"记得前文"的全部关键）')
		check(expected !== undefined && written.rewind.pending.resumeAt === expected.uuid, '接续点必须是那一轮自己的锚点')
		check(
			written.rewind.anchors.every((item) => item.turn <= forkTurn),
			`锚点必须裁到 ≤${forkTurn}，实际 ${written.rewind.anchors.map((item) => item.turn)}`,
		)
		check(
			written.activities.every((item) => item.turn <= forkTurn),
			'助手正文必须裁到岔路点为止，否则新分支会显示出父分支后来的回答',
		)
		check(written.schemaVersion === 1, 'schema 必须合法，否则 dsh-claude 读的时候直接抛')
		check(JSON.stringify(JSON.parse(fs.readFileSync(path.join(sidecarDir, sidecarName(claudeParentId)), 'utf8'))) === JSON.stringify(parentDocument), '父分支的 sidecar 一个字节都不能动')
		console.log('       绑定 / 接续点 / 裁剪 / 父分支未被动 —— 全部正确')

		// 再接管一次：已经有 sidecar 了，必须拒绝覆盖
		const snapshot = fs.readFileSync(childFile, 'utf8')
		adoptBranch(ctx, claudeCase)
		check(fs.readFileSync(childFile, 'utf8') === snapshot, '已经跑过的分支绝不能被二次覆盖')
		console.log('断言 B2：重复接管不会覆盖已跑过的分支')
	}
}

// ===== 第 5 步：断言 B3 —— 父会话正在跑的时候，一个字节都不读 =====
//
// 这是最要命的一条。读父会话的旁车会让 dsh-claude 的原子写 rename 撞上 EPERM，
// 它把那当成"Claude Code 掉线"，**整轮判失败而且故意不重放**。
// 所以宁可让新分支没有上下文（界面上会明说），也绝不在它跑着的时候去读。
if (claudeParentId === undefined) {
	console.log('断言 B3：跳过（没有可用的父 sidecar）')
} else {
	const childFile = path.join(sidecarDir, sidecarName(claudeCaseId))
	fs.rmSync(childFile, { force: true })
	const asked = []
	const busyCtx = {
		logger: { info() {}, warn() {} },
		agents: { get: (id) => (asked.push(id), { status: 'running' }) },
	}
	adoptBranch(busyCtx, rewind(claudeCaseId))
	check(!fs.existsSync(childFile), '父会话在跑的时候，绝不能写出 sidecar —— 写了就说明读过它')
	check(asked.length > 0, '压根没问过"它在不在跑"，那这道闸等于不存在')

	// 反过来：同一个分支，父会话空闲时必须照常接上 —— 否则这道闸就是把功能关了
	adoptBranch(ctx, rewind(claudeCaseId))
	check(fs.existsSync(childFile), '父会话空闲时必须照常接上上下文（闸不能把功能一起关掉）')

	// 认不出状态时必须当成"在跑"（fail-closed）：赌错了的代价是打死用户一轮对话
	fs.rmSync(childFile, { force: true })
	adoptBranch({ logger: { info() {}, warn() {} } }, rewind(claudeCaseId))
	check(!fs.existsSync(childFile), '问不出会话状态时必须当成"在跑"，不许乐观放行')

	// 直接调 graft 而漏给 isBusy：必须当场拒绝，不许"默认谁都不在跑"。
	// 这是个**沉默的**错误路径 —— 漏给一个参数就等于把整道闸拆了，
	// 而拆了之后一切看起来都正常，直到某天打死用户一轮对话。
	const sloppy = host.graft(claudeCaseId, claudeParentId, forkTurn)
	check(sloppy.grafted === false && sloppy.reason === 'bad-request', `漏给 isBusy 时必须拒绝，实际 ${JSON.stringify(sloppy)}`)
	check(!fs.existsSync(childFile), '漏给 isBusy 却还是写了文件 —— 那道闸形同虚设')

	// 把世界恢复成断言 B 留下的样子：那份 sidecar 本来就该在，
	// 下面第 6 步要数文件个数，少一份的话重启重放那一段会把它又建出来
	adoptBranch(ctx, rewind(claudeCaseId))
	console.log('断言 B3：父会话在跑 / 状态认不出 → 不读不写；空闲 → 照常接上')
}

// ===== 第 6 步：断言 C —— 不该动的时候一个字节都不动 =====


const before = new Set(fs.readdirSync(sidecarDir))

// 普通 provider：血缘上一个 sidecar 都没有 → 什么都不该发生
const plainId = branchIds.find((id) => {
	const parentId = parentOf.get(id)
	return parentId !== undefined && !fs.existsSync(path.join(sidecarDir, sidecarName(parentId)))
})
if (plainId !== undefined) {
	adoptBranch(ctx, rewind(plainId))
	check(!fs.existsSync(path.join(sidecarDir, sidecarName(plainId))), '普通 provider 路径上一个文件都不许写')
}

// **重启重放**：dsh 起来时会把盘上每个会话 resume 一遍，`agent/created` 照样触发。
// 那时队列里可能正躺着用户自己排的待办 —— 删掉就是丢数据。
// 因为只按"继承段折出来的 id"删，用户后来排的那条 id 对不上，天然安全。
const restarted = rewind(branchIds[0])
restarted.inbox.nextTurn.push({ id: 'mine-own-id', content: [{ type: 'text', text: '我自己排的队' }] })
adoptBranch(ctx, restarted)
check(
	restarted.inbox.nextTurn.some((message) => message.id === 'mine-own-id'),
	'重启重放时，用户自己排的待办绝不能被删掉',
)
check(
	restarted.inbox.nextTurn.every((message) => message.id === 'mine-own-id') && restarted.inbox.nextStep.length === 0,
	'继承来的那几条还是要删干净',
)

// 不是分支（isSeeded 不为 true）→ 直接跳过，连队列都不许碰
let touched = false
adoptBranch(ctx, {
	id: 'session-plain',
	inbox: {
		nextTurn: [{ id: 'x', content: [{ type: 'text', text: '用户自己排的队' }] }],
		nextStep: [],
		hasPending: true,
		remove() {
			touched = true
			return true
		},
	},
	session: { id: 'session-plain', inheritedEventCount: 0, header: { isSeeded: false }, snapshotEvents: () => [] },
})
check(touched === false, '普通会话（不是分支）的待办绝不能被清掉')

// sidecar 版本变了 → 立刻装死
if (claudeParentId !== undefined) {
	const future = rewind(claudeCaseId)
	const parentCopy = path.join(sidecarDir, sidecarName(claudeParentId))
	const saved = fs.readFileSync(parentCopy, 'utf8')
	fs.writeFileSync(parentCopy, JSON.stringify({ ...JSON.parse(saved), schemaVersion: 2 }))
	const victim = { ...future, id: 'session-future', session: { ...future.session, id: 'session-future' } }
	lineage.set('session-future', claudeParentId)
	adoptBranch(ctx, victim)
	check(!fs.existsSync(path.join(sidecarDir, sidecarName('session-future'))), 'sidecar 版本对不上时必须停手，不许写')
	fs.writeFileSync(parentCopy, saved)
}

check(
	[...fs.readdirSync(sidecarDir)].filter((name) => !before.has(name)).length === 0,
	`第5步不该产生任何新文件，实际多了 ${[...fs.readdirSync(sidecarDir)].filter((name) => !before.has(name))}`,
)
console.log('断言 C：不该动的情况下，一个字节都没动')

fs.rmSync(home, { recursive: true, force: true })
report()
