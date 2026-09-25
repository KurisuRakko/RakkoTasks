// 设置页「邮箱账户」分区（原「账户状态」分区的继任者）：
// 挂载时 fetchStatus()；列出账户卡片（名称/邮箱/类型/状态 Chip/上次同步/错误），
// 头部右侧「添加邮箱」，底部一行 AI 待处理数。
// 桌面（md 起）点卡片或「添加邮箱」在 Dialog 里开 详情/向导/移除二选一（同一个 Dialog 切内容）；
// 移动端跳独立路由页 /settings/accounts/*。Dialog 关闭或任一子流程完成后重新 fetchStatus。

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { fetchStatus } from "../../lib/api";
import { mainAreaDialogSx, EMPTY_STATE_BOX_SX } from "../../lib/layout";
import { enterSx, usePrefersReducedMotion } from "../../lib/motion";
import { useNavigateTo } from "../../lib/nav";
import { cardRowSx } from "../../lib/surface";
import { dialogPanelGlassSx } from "./dialog-glass";
import { timeAgo } from "../../lib/time";
import { MOTION } from "../../rakko-tokens";
import { statusChipMeta, kindLabel, kindAvatar } from "./meta";
import SettingsRow, { HINT_SX, ROW_MIN_HEIGHT_PX, rowSeparatorSx } from "./SettingsRow";
import AccountDetail from "./AccountDetail";
import AccountWizard from "./AccountWizard";
import RemoveAccountChoice from "./RemoveAccountChoice";
import type { AccountInfo, StatusResponse } from "../../types";
import type { SystemStyleObject } from "@mui/system";
import { SlideUp } from "../DialogTransition";

/** 桌面 Dialog 的三种内容：添加向导 / 账户详情 / 移除二选一，同一个 Dialog 切换 */
type AccountDialog =
  | { view: "wizard" }
  | { view: "detail"; account: AccountInfo }
  | { view: "remove"; account: AccountInfo };

function dialogTitle(dialog: AccountDialog | null): string {
  if (!dialog) return "";
  switch (dialog.view) {
    case "wizard":
      return "添加邮箱账户";
    case "detail":
      return "账户详情";
    case "remove":
      return "移除账户";
  }
}

/** 对话框纸面的 panel 材质 props：'data-glass' 取配方（见 dialog-glass.ts 的接线）。
 *  提成模块级常量而不是行内字面量：MUI 的 slotProps 类型对行内字面量做 excess property
 *  check，data-* 不在其类型里，常量赋值可绕过（同 RowContextMenu 的 MENU_PAPER_PROPS）。 */
const ACCOUNTS_DIALOG_PAPER_PROPS = { 'data-glass': 'panel' };

export default function AccountsSection() {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  const go = useNavigateTo();
  const reduced = usePrefersReducedMotion();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  // 退场期间还得继续渲染内容：dialog 一置 null，下面按它条件渲染的子树会被立刻拆掉，
  // Dialog 的退场过渡根本跑不到（速记面板修过同一个洞）。这份「上一次内容」只在
  // onExited 时清，退场的 250ms 里用户看到的还是原内容，而不是空壳往下滑。
  const [exiting, setExiting] = useState<AccountDialog | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetchStatus()
      .then((s) => {
        if (alive) setData(s);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => load(), [load]);

  /** 桌面开 Dialog / 移动端跳路由，两条路径的入口共用一个判断 */
  const openAdd = () => {
    if (desktop) setDialog({ view: "wizard" });
    else go("/settings/accounts/new");
  };
  const openDetail = (account: AccountInfo) => {
    if (desktop) setDialog({ view: "detail", account });
    else go(`/settings/accounts/${account.id}`);
  };

  /** Dialog 关闭（含向导取消/完成、详情关闭）：收起并刷新列表 */
  const closeDialog = () => {
    // 退场途中内容仍然挂着、按钮也还能点：已经关上了就当没这回事，
    // 否则第二次调用会把正在退场的内容抹掉、退场当场断掉
    if (dialog === null) return;
    setExiting(dialog);
    setDialog(null);
    load();
  };

  // 渲染依据是「当前内容 ?? 正在退场的内容」；是否打开仍只看 dialog
  const shown = dialog ?? exiting;
  // 三种视图的当前数据：null 表示该视图没开着（局部常量便于在回调里安全引用）
  const wizardOpen = shown?.view === "wizard";
  const detailAccount = shown?.view === "detail" ? shown.account : null;
  const removeAccount = shown?.view === "remove" ? shown.account : null;

  return (
    <Box>
      {/* 标题行与设置行同一最小高度：分区标题（无论带不带右侧按钮）落在同一条基线上 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 0.5, minHeight: `${ROW_MIN_HEIGHT_PX}px` }}
      >
        <Typography variant="overline" component="h2" sx={{ flexGrow: 1, minWidth: 0 }}>
          邮箱账户
        </Typography>
        {/* 添加邮箱是这一分区的主操作：全站主操作只有 contained 一种 */}
        <Button variant="contained" size="small" onClick={openAdd}>
          添加邮箱
        </Button>
      </Stack>

      {loading && !data ? (
        <Box sx={EMPTY_STATE_BOX_SX}>
          <CircularProgress />
        </Box>
      ) : error && !data ? (
        <Alert severity="error">加载账户失败</Alert>
      ) : data ? (
        // 列表不再靠 Stack 的间距分行：账户行与设置页其余分区同一套行结构，行与行之间
        // 是一条 inset 发丝线而不是 12px 空隙（两者同时存在就等于两种节奏叠在一起）。
        // 这里的 8px 只作用于「最后一行 → AI 待处理行」这一段。
        <Stack spacing={1}>
          {data.accounts.length === 0 ? (
            <Typography variant="body2" sx={{ textAlign: "center", py: 2 }}>
              还没有接入邮箱账户，点右上角「添加邮箱」开始接入。
            </Typography>
          ) : (
            <Box>
              {data.accounts.map((a, index) => {
                const chip = statusChipMeta(a);
                const disabled = !a.enabled;
                return (
                  <ButtonBase
                    key={a.id}
                    data-account-row
                    onClick={() => openDetail(a)}
                    // 行不再是 outlined 卡片：外层分区已是玻璃面板，再套一层带边框的卡片
                    // 就是两层框。行直接坐在面板玻璃上，按压反馈由 ButtonBase 的 state
                    // layer 给。
                    //
                    // 行结构（左右内边距、最小高度、相邻行之间的 inset 发丝线）与设置页
                    // 其余分区共用 SettingRow 那一套：账户列表也是设置行的一种，只是左侧
                    // 多一个头像、右侧是状态 Chip。行自己不写行高与间距，两处不一致就是
                    // 节奏不一致。
                    //
                    // 变暗用 filter 而非 opacity：入场动画 animation-fill-mode: both
                    // 会把关键帧终态 opacity: 1 保持在元素上（动画值优先级高于普通声明），
                    // 静态 opacity 会被压掉；filter 与动画互不干扰（见 accounts-section.test）。
                    sx={[
                      // enterSx 的签名是 SxProps<Theme>（可为回调/字符串），这里只取它
                      // 实际返回的对象形态：与下面的行几何、rowSeparatorSx 拼成同一个
                      // SystemStyleObject 数组，ButtonBase 的 sx 才收得下
                      enterSx(index, reduced) as SystemStyleObject<Theme>,
                      rowSeparatorSx,
                      {
                        ...cardRowSx(),
                        filter: disabled ? "opacity(0.6)" : "none",
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        px: 1,
                        minHeight: `${ROW_MIN_HEIGHT_PX}px`,
                        py: 1,
                      },
                    ]}
                  >
                    <SettingsRow
                      leading={<Avatar>{kindAvatar(a.kind)}</Avatar>}
                      label={
                        <>
                          <Typography variant="subtitle1" noWrap>
                            {a.name}
                          </Typography>
                          <Typography variant="caption" sx={{ display: "block" }} noWrap>
                            {a.email}
                          </Typography>
                          {/* 元信息只用一种字阶（caption）+ 正文色 n9：玻璃上的次级文字
                              n7 实测对比度只有 2.4–2.6，层级靠字号拉开而不是靠变淡 */}
                          <Typography variant="caption" sx={HINT_SX}>
                            {kindLabel(a.kind)} · 上次同步：
                            {a.last_sync_at ? timeAgo(a.last_sync_at) : "从未"}
                          </Typography>
                        </>
                      }
                      value={
                        // 状态用语义色：正常 success / 出错 error / 等首次同步 info /
                        // 待授权 warning / 已停用 default，一律 outlined 小芯片
                        <Chip
                          label={chip.label}
                          size="small"
                          color={chip.color}
                          variant="outlined"
                        />
                      }
                    />
                    {a.enabled && a.last_error && (
                      // 错误行是同一行的追加信息：不占一整行的高度，贴着上行往下排。
                      // 它不参与分隔线（行结构里只有设置行画线，这段是行内追加内容），
                      // 也没有自己的 min-height；缩进 = 头像 40px + gap 12px
                      <Typography
                        variant="caption"
                        color="error"
                        sx={{
                          display: "block",
                          pl: "52px",
                          pr: 1,
                          pb: 0.75,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          textAlign: "left",
                        }}
                      >
                        {a.last_error}
                      </Typography>
                    )}
                  </ButtonBase>
                );
              })}
              {/* 队列清空时不占位：常驻一行「AI 待处理 0 封」只是噪音 */}
              {data.pending_llm > 0 && (
                <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
                  AI 待处理 {data.pending_llm} 封
                </Alert>
              )}
            </Box>
          )}
        </Stack>
      ) : null}

      {/* 桌面端交互收在同一个 Dialog 里：三种内容互切，移动端走路由页（本组件不渲染 Dialog） */}
      <Dialog
        open={dialog !== null && desktop}
        onClose={closeDialog}
        maxWidth="sm"
        fullWidth
        sx={[mainAreaDialogSx, dialogPanelGlassSx]}
        // 固定用 SlideUp，两个方向都由 MUI 自己跑：这个对话框不是从某一行经 View
        // Transitions 容器变换长出来的（openAdd / openDetail 只是 setDialog），
        // 用 dialogTransitionProps() 会在支持 VT 的浏览器上把 MUI 过渡设成 0ms
        // 去给一个根本不会发生的 VT 让位，结果就是开关都没有动效。
        TransitionComponent={SlideUp}
        transitionDuration={reduced ? 0 : { enter: MOTION.large, exit: MOTION.largeExit }}
        TransitionProps={{ onExited: () => setExiting(null) }}
        // 纸面与移动端 AccountPages 的 <Box data-glass="panel"> 同一档材质：同一个「账户
        // 详情」不该因为断点不同就换一种质感。走 slotProps.paper（MUI 6.5 的现行写法）。
        slotProps={{ paper: ACCOUNTS_DIALOG_PAPER_PROPS }}
        aria-labelledby="accounts-dialog-title"
      >
        <DialogTitle id="accounts-dialog-title">
          <Stack direction="row" alignItems="center">
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              {dialogTitle(shown)}
            </Typography>
            <IconButton
              edge="end"
              aria-label="关闭"
              onClick={closeDialog}
              size="small"
            >
              <CloseIcon />
            </IconButton>
          </Stack>
        </DialogTitle>
        <Box sx={{ px: 3, pb: 3 }}>
          {wizardOpen && (
            <AccountWizard onDone={closeDialog} onCancel={closeDialog} />
          )}
          {detailAccount && (
            <AccountDetail
              key={detailAccount.id}
              account={detailAccount}
              onChanged={(updated) => {
                // 对话框内继续用新账户，列表随后台刷新同步
                setDialog({ view: "detail", account: updated });
                load();
              }}
              onRemove={() =>
                setDialog({ view: "remove", account: detailAccount })
              }
            />
          )}
          {removeAccount && (
            <RemoveAccountChoice
              key={removeAccount.id}
              account={removeAccount}
              onDisabled={() => closeDialog()}
              onDeleted={() => closeDialog()}
              onCancel={() =>
                setDialog({ view: "detail", account: removeAccount })
              }
            />
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
