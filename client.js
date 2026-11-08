/**
 * WorkBuddy 每日积分 —— 浏览器半身。
 *
 * 在输入框下方的 dock 槽位里放一张小卡片：显示签到状态、连续签到天数、
 * 积分余额与福利活动，并提供「网页登录」「领取签到积分」「领取福利积分」。
 * 认证全走 WorkBuddy 官方网页 OAuth，用户不需要安装桌面客户端。
 */

window.__ModuleLoader__.load({
	id: "dsh-workbuddy-daily-credits",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		const NS = "workbuddyDailyCredits";
		const SLOT_ID = "dsh-workbuddy-daily-credits";
		const SLOT_ORDER = 12;

		/** API 前缀用文档相对路径解析，反向代理挂在子路径下也不会丢前缀。 */
		const API = (() => {
			try {
				return new URL("api/dsh-workbuddy-daily-credits", document.baseURI).pathname.replace(/\/$/, "");
			} catch {
				return "/api/dsh-workbuddy-daily-credits";
			}
		})();

		const zh = {
			title: "WorkBuddy 每日积分",
			loading: "读取中…",
			signIn: "登录 WorkBuddy",
			signedInAs: "已登录",
			signOut: "退出登录",
			refresh: "刷新",
			claiming: "领取中…",
			claimCheckin: "领取今日签到",
			claimedToday: "今日已领取",
			checkinPending: "今日未领取",
			streak: "连续签到",
			days: "天",
			dailyCredit: "每日积分",
			balance: "积分余额",
			benefits: "福利活动",
			benefitCompensation: "补偿金",
			benefitGift: "新人礼",
			benefitReady: "可领取",
			benefitClaimed: "已领取",
			benefitClosed: "未开放",
			claimBenefit: "领取福利",
			regionCn: "国内版",
			regionGlobal: "国际版",
			regionLabel: "账号区域",
			notSignedIn: "还没有登录 WorkBuddy 账号，点「登录 WorkBuddy」用网页授权即可（无需安装客户端）。",
			failed: "读取失败",
			loginOpened: "已打开登录页，请在浏览器里完成授权，这里会自动等待…",
			loginTimeout: "登录等待超时，请重新发起登录",
			loginFailed: "登录失败",
			claimDone: "领取成功",
			claimFailed: "领取失败",
			claimSuccess: "已领取 {amount} 积分，连续 {streak} 天",
			claimAlready: "今天的签到积分已经领过了",
			noBenefits: "当前没有可领取的福利活动",
		};

		const en = {
			title: "WorkBuddy daily credits",
			loading: "Loading…",
			signIn: "Sign in to WorkBuddy",
			signedInAs: "Signed in",
			signOut: "Sign out",
			refresh: "Refresh",
			claiming: "Claiming…",
			claimCheckin: "Claim today's credits",
			claimedToday: "Claimed today",
			checkinPending: "Not claimed today",
			streak: "Streak",
			days: "days",
			dailyCredit: "Daily credit",
			balance: "Balance",
			benefits: "Benefits",
			benefitCompensation: "Compensation",
			benefitGift: "Newcomer gift",
			benefitReady: "Claimable",
			benefitClaimed: "Claimed",
			benefitClosed: "Closed",
			claimBenefit: "Claim benefit",
			regionCn: "China",
			regionGlobal: "Global",
			regionLabel: "Account region",
			notSignedIn: "No WorkBuddy account yet. Sign in with the web page — no desktop client needed.",
			failed: "Failed to load",
			loginOpened: "Login page opened. Finish the authorization there; this card keeps waiting.",
			loginTimeout: "Login timed out. Please start again.",
			loginFailed: "Sign-in failed",
			claimDone: "Claimed",
			claimFailed: "Claim failed",
			claimSuccess: "Claimed {amount} credits, {streak}-day streak",
			claimAlready: "Today's credits were already claimed",
			noBenefits: "No claimable benefit right now",
		};

		const styles = {
			dock: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: "8px",
				padding: "6px 10px",
				margin: "4px 0",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24))",
				background: "var(--dsw-alias-bg-layer-1, transparent)",
				color: "var(--dsw-alias-label-primary, inherit)",
				fontSize: "12px",
				lineHeight: 1.5,
			},
			brand: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary, inherit)",
			},
			dot: {
				width: "8px",
				height: "8px",
				borderRadius: "50%",
				background: "var(--dsw-alias-state-idle-primary, #9aa0a6)",
				flex: "none",
			},
			dotOk: {
				background: "var(--dsw-alias-state-success-primary, #2e9e5b)",
			},
			dotWarn: {
				background: "var(--dsw-alias-state-warn-primary, #c8912a)",
			},
			dotError: {
				background: "var(--dsw-alias-state-error-primary, #d1453b)",
			},
			stat: {
				color: "var(--dsw-alias-label-secondary, inherit)",
				whiteSpace: "nowrap",
			},
			value: {
				color: "var(--dsw-alias-label-primary, inherit)",
				fontWeight: 600,
			},
			spacer: {
				flex: "1 1 auto",
			},
			button: {
				border: "1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.32))",
				borderRadius: "7px",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				color: "var(--dsw-alias-label-primary, inherit)",
				padding: "3px 10px",
				fontSize: "12px",
				lineHeight: 1.6,
				cursor: "pointer",
			},
			primary: {
				borderColor: "var(--dsw-alias-brand-primary, transparent)",
				color: "var(--dsw-alias-brand-primary, inherit)",
				fontWeight: 600,
			},
			disabled: {
				opacity: 0.55,
				cursor: "default",
			},
			note: {
				flexBasis: "100%",
				color: "var(--dsw-alias-label-secondary, inherit)",
				fontSize: "11px",
			},
			chip: {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				padding: "1px 8px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24))",
				color: "var(--dsw-alias-label-secondary, inherit)",
			},
			chipReady: {
				borderColor: "var(--dsw-alias-state-success-primary, transparent)",
				color: "var(--dsw-alias-state-success-primary, inherit)",
			},
			select: {
				border: "1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.32))",
				borderRadius: "7px",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				color: "var(--dsw-alias-label-primary, inherit)",
				padding: "2px 6px",
				fontSize: "12px",
			},
		};

		/** 统一的 fetch 包装：超时 + JSON 解析 + 错误消息。 */
		async function api(path, options) {
			const timeout = options && typeof options.timeout === "number" ? options.timeout : 15000;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			try {
				const response = await fetch(`${API}${path}`, {
					method: (options && options.method) || "GET",
					headers: { accept: "application/json", ...(options && options.headers ? options.headers : {}) },
					body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
					redirect: "error",
					signal: controller.signal,
				});
				const text = await response.text();
				let payload = {};
				try {
					payload = text.length > 0 ? JSON.parse(text) : {};
				} catch {
					payload = {};
				}
				if (!response.ok) {
					throw new Error(typeof payload.error === "string" && payload.error.length > 0 ? payload.error : `HTTP ${response.status}`);
				}
				return payload;
			} finally {
				clearTimeout(timer);
			}
		}

		function benefitLabel(t, kind) {
			return kind === "gift" ? t("benefitGift") : t("benefitCompensation");
		}

		function benefitState(t, benefit) {
			if (benefit.claimed === true) return { text: t("benefitClaimed"), ready: false };
			if (benefit.active === true) return { text: t("benefitReady"), ready: true };
			return { text: t("benefitClosed"), ready: false };
		}

		/**
		 * 输入框下方的小卡片。
		 * @param {{ t?: (key: string) => string }} props
		 */
		function WorkBuddyCreditsDock(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const [status, setStatus] = react.useState(undefined);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");
			const [region, setRegion] = react.useState("cn");
			const [pending, setPending] = react.useState(false);

			const load = react.useCallback(async () => {
				try {
					const value = await api("/status", { timeout: 20000 });
					setStatus(value);
					setError("");
					if (value && value.region === "global") setRegion("global");
				} catch (failure) {
					setError(failure && failure.message ? failure.message : String(failure));
				}
			}, []);

			react.useEffect(() => { load(); }, [load]);

			/** 登录流程：申请 state → 打开网页 → 轮询 token。 */
			const signIn = react.useCallback(async () => {
				setBusy(true);
				setNotice("");
				setError("");
				try {
					const started = await api("/oauth/start", { method: "POST", body: { region } });
					if (typeof started.error === "string" && started.error.length > 0) {
						setError(started.error);
						setBusy(false);
						return;
					}
					const opened = window.open(started.verificationUri, "_blank", "noopener,noreferrer");
					if (opened === null) {
						setError(started.verificationUri);
						setBusy(false);
						return;
					}
					setPending(true);
					setNotice(t("loginOpened"));
					const deadline = Date.now() + (typeof started.expiresIn === "number" ? started.expiresIn : 600) * 1000;
					while (Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 2000));
						const polled = await api("/oauth/poll", { method: "POST", body: { loginId: started.loginId } });
						if (polled.done === true) {
							setPending(false);
							setNotice("");
							setBusy(false);
							if (typeof polled.error === "string" && polled.error.length > 0) {
								setError(polled.error);
								return;
							}
							await load();
							return;
						}
					}
					setPending(false);
					setNotice("");
					setBusy(false);
					setError(t("loginTimeout"));
				} catch (failure) {
					setPending(false);
					setBusy(false);
					setError(failure && failure.message ? failure.message : String(failure));
				}
			}, [region, t, load]);

			const claimCheckin = react.useCallback(async () => {
				setBusy(true);
				setNotice("");
				setError("");
				try {
					const result = await api("/claim/checkin", { method: "POST", body: {} });
					if (result.alreadyCheckedIn === true) {
						setNotice(t("claimAlready"));
					} else {
						const claim = result.claim || {};
						setNotice(t("claimSuccess", { amount: String(claim.credit ?? 0), streak: String(claim.streakDays ?? 0) }));
					}
					await load();
				} catch (failure) {
					setError(failure && failure.message ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			}, [t, load]);

			const claimBenefit = react.useCallback(async (kind) => {
				setBusy(true);
				setNotice("");
				setError("");
				try {
					await api("/claim/benefit", { method: "POST", body: { kind } });
					setNotice(t("claimDone"));
					await load();
				} catch (failure) {
					setError(failure && failure.message ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			}, [t, load]);

			const signOut = react.useCallback(async () => {
				setBusy(true);
				setError("");
				try {
					await api("/sign-out", { method: "POST", body: {} });
					setStatus(undefined);
					await load();
				} catch (failure) {
					setError(failure && failure.message ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			}, [load]);

			if (status === undefined && error === "") {
				return jsxRuntime.jsx("div", {
					style: styles.dock,
					children: jsxRuntime.jsx("span", { style: styles.stat, children: t("loading") }),
				});
			}

			const signedIn = status !== undefined && status.signedIn === true;
			const checkin = signedIn ? status.checkin : undefined;
			const credits = signedIn ? status.credits : undefined;
			const benefits = signedIn && Array.isArray(status.benefits) ? status.benefits : [];
			const readyBenefits = benefits.filter((benefit) => benefit.active === true && benefit.claimed !== true);
			const dotStyle = error !== ""
				? styles.dotError
				: !signedIn
					? styles.dot
					: checkin && checkin.todayCheckedIn === true
						? styles.dotOk
						: styles.dotWarn;

			const button = (label, onClick, options) => {
				const opts = options || {};
				return jsxRuntime.jsx("button", {
					type: "button",
					style: {
						...styles.button,
						...(opts.primary ? styles.primary : {}),
						...(opts.disabled ? styles.disabled : {}),
					},
					disabled: opts.disabled === true,
					onClick,
					children: label,
				});
			};

			const children = [
				jsxRuntime.jsx("span", { key: "brand", style: styles.brand, children: [
					jsxRuntime.jsx("span", { key: "dot", style: dotStyle }),
					jsxRuntime.jsx("span", { key: "label", children: t("title") }),
				] }),
			];

			if (!signedIn) {
				children.push(jsxRuntime.jsx("span", { key: "region", style: styles.stat, children: `${t("regionLabel")}: ` }));
				children.push(jsxRuntime.jsx("select", {
					key: "region-select",
					style: styles.select,
					value: region,
					onChange: (event) => setRegion(event.target.value),
					children: [
						jsxRuntime.jsx("option", { key: "cn", value: "cn", children: t("regionCn") }),
						jsxRuntime.jsx("option", { key: "global", value: "global", children: t("regionGlobal") }),
					],
				}));
				children.push(button(t("signIn"), signIn, { primary: true, disabled: busy }));
				children.push(jsxRuntime.jsx("span", { key: "spacer", style: styles.spacer }));
			} else {
				const account = status.account || {};
				const nickname = account.nickname && account.nickname.length > 0 ? account.nickname : account.domain;
				children.push(jsxRuntime.jsx("span", { key: "account", style: styles.stat, children: [
					jsxRuntime.jsx("span", { key: "label", children: `${t("signedInAs")}: ` }),
					jsxRuntime.jsx("span", { key: "value", style: styles.value, children: nickname }),
				] }));
				if (checkin) {
					children.push(jsxRuntime.jsx("span", { key: "streak", style: styles.stat, children: [
						jsxRuntime.jsx("span", { key: "label", children: `${t("streak")}: ` }),
						jsxRuntime.jsx("span", { key: "value", style: styles.value, children: `${String(checkin.streakDays)} ${t("days")}` }),
					] }));
					children.push(jsxRuntime.jsx("span", { key: "daily", style: styles.stat, children: [
						jsxRuntime.jsx("span", { key: "label", children: `${t("dailyCredit")}: ` }),
						jsxRuntime.jsx("span", { key: "value", style: styles.value, children: String(checkin.dailyCredit) }),
					] }));
				}
				if (credits !== undefined) {
					children.push(jsxRuntime.jsx("span", { key: "balance", style: styles.stat, children: [
						jsxRuntime.jsx("span", { key: "label", children: `${t("balance")}: ` }),
						jsxRuntime.jsx("span", { key: "value", style: styles.value, children: String(credits.remain) }),
					] }));
				}
				if (checkin) {
					children.push(button(
						checkin.todayCheckedIn === true ? t("claimedToday") : t("claimCheckin"),
						claimCheckin,
						{ primary: checkin.todayCheckedIn !== true, disabled: busy || checkin.todayCheckedIn === true },
					));
				}
				if (readyBenefits.length > 0) {
					for (const benefit of readyBenefits) {
						children.push(button(
							`${t("claimBenefit")} · ${benefitLabel(t, benefit.kind)} (+${String(benefit.creditNum)})`,
							() => claimBenefit(benefit.kind),
							{ disabled: busy },
						));
					}
				}
				children.push(button(t("refresh"), load, { disabled: busy }));
				children.push(button(t("signOut"), signOut, { disabled: busy }));
				children.push(jsxRuntime.jsx("span", { key: "spacer", style: styles.spacer }));
			}

			if (benefits.length > 0) {
				for (const benefit of benefits) {
					const state = benefitState(t, benefit);
					children.push(jsxRuntime.jsx("span", {
						key: `benefit-${benefit.kind}`,
						style: {
							...styles.chip,
							...(state.ready ? styles.chipReady : {}),
						},
						children: `${benefitLabel(t, benefit.kind)} ${state.text}`,
					}));
				}
			}

			const note = notice !== "" ? notice : error !== "" ? error : signedIn ? "" : t("notSignedIn");
			if (note !== "") {
				children.push(jsxRuntime.jsx("span", {
					key: "note",
					style: styles.note,
					children: note,
				}));
			}

			return jsxRuntime.jsx("div", { style: styles.dock, children });
		}

		/** 需要的客户端服务：slot 注册表与本地化字典。 */
		const inject = ["slots", "locale"];

		/**
		 * 注册客户端资源。
		 * @param {object} ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-workbuddy-daily-credits: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: SLOT_ID,
				order: SLOT_ORDER,
				locale: NS,
				inject: () => ({ t }),
			}, WorkBuddyCreditsDock));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		exports.WorkBuddyCreditsDock = WorkBuddyCreditsDock;
		return module.exports;
	},
});
