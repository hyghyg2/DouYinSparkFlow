import time
import traceback

from playwright.sync_api import Response

from core.browser import get_browser
from core.msg_builder import build_message
from utils import norm
from utils.config import get_config, get_userData
from utils.logger import setup_logger

config = get_config()
userData = get_userData()
logger = setup_logger(level=config.get("logLevel", "Info"))
userIDDict = {}

CONVERSATION_ITEM_SELECTOR = ".conversationConversationItemwrapper"
CONVERSATION_TITLE_SELECTOR = ".conversationConversationItemtitle"
CONVERSATION_LIST_SELECTOR = ".conversationConversationListwrapper"
CHAT_EDITOR_SELECTOR = ".messageEditorimChatEditorContainer"


def handle_response(response: Response):
    """
    监听聊天页用户信息接口，补全备注/昵称/抖音号映射关系。
    """
    global userIDDict

    if "aweme/v1/web/im/user/info" not in response.url:
        return

    try:
        json_data = response.json()
        for item in json_data.get("data", []):
            short_id = item.get("short_id")
            unique_id = item.get("unique_id")
            sec_uid = item.get("sec_uid", "")
            nickname = norm(item.get("nickname", ""))
            remark_name = norm(item.get("remark_name") or nickname)
            if not remark_name:
                continue
            userIDDict[remark_name] = [
                short_id,
                unique_id,
                sec_uid,
                nickname,
                remark_name,
            ]
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        last = tb[-1]
        print(f"解析响应失败: {e}")
        print(f"文件: {last.filename}, 行号: {last.lineno}, 函数: {last.name}")


def retry_operation(name, operation, retries=3, delay=2, *args, **kwargs):
    """
    通用重试逻辑。
    """
    for attempt in range(retries):
        try:
            return operation(*args, **kwargs)
        except Exception as e:
            if attempt < retries - 1:
                logger.warning(f"{name} 失败，正在重试第 {attempt + 1} 次，错误：{e}")
                time.sleep(delay)
            else:
                logger.error(f"{name} 失败，已达到最大重试次数，错误：{e}")
                raise


def check_target_name(target_name, targets):
    """
    检查当前会话标题是否对应目标账号。
    """
    target_name = norm(target_name)
    if not target_name:
        return None

    if target_name in userIDDict:
        return next(
            (value for value in userIDDict[target_name] if value and value in targets),
            None,
        )

    if target_name in targets:
        return target_name

    return None


def scroll_and_select_user(page, account_name, targets):
    """
    在 douyin.com/chat 左侧会话列表中滚动查找目标。
    """
    logger.debug(f"账号 {account_name} 开始查找目标好友列表")
    logger.debug(f"账号 {account_name} 目标好友列表: {targets}")

    page.wait_for_selector(CONVERSATION_LIST_SELECTOR, timeout=config["browserTimeout"])

    found_targets = set()
    remaining_targets = set(targets)
    empty_scroll_count = 0
    max_empty_scrolls = 10

    while True:
        target_elements = page.locator(CONVERSATION_ITEM_SELECTOR).all()
        previous_found_count = len(found_targets)

        for element in target_elements:
            try:
                target_name = norm(element.locator(CONVERSATION_TITLE_SELECTOR).inner_text())
                if not target_name or target_name in found_targets:
                    continue

                found_targets.add(target_name)
                logger.debug(f"账号 {account_name} 找到好友 {target_name}")

                target_symbol = check_target_name(target_name, targets)
                if not target_symbol:
                    continue

                element.click()
                yield target_symbol

                if target_symbol in remaining_targets:
                    remaining_targets.remove(target_symbol)
                if not remaining_targets:
                    logger.debug(f"账号 {account_name} 所有目标好友均已找到，停止搜索")
                    return
                break
            except Exception:
                traceback.print_exc()
        else:
            if len(found_targets) > previous_found_count:
                empty_scroll_count = 0
            else:
                empty_scroll_count += 1

            if empty_scroll_count >= max_empty_scrolls:
                logger.warning(
                    f"账号 {account_name} 连续 {max_empty_scrolls} 次滚动未发现新好友，判定已到达底部"
                )
                if remaining_targets:
                    logger.warning(
                        f"账号 {account_name} 搜索结束，仍有以下好友未找到: {sorted(remaining_targets)}"
                    )
                break

            scrollable_element = page.locator(CONVERSATION_LIST_SELECTOR).element_handle()
            if not scrollable_element:
                logger.error(f"账号 {account_name} 未找到会话列表容器，退出")
                break

            scroll_top_before = page.evaluate(
                "(element) => element.scrollTop", scrollable_element
            )
            page.evaluate("(element) => element.scrollTop += 800", scrollable_element)
            time.sleep(0.3)
            scroll_top_after = page.evaluate(
                "(element) => element.scrollTop", scrollable_element
            )

            if scroll_top_before == scroll_top_after:
                empty_scroll_count += 2
                logger.debug(
                    f"账号 {account_name} scrollTop 未变化 ({scroll_top_before})，可能已到底 "
                    f"(空滚动计数: {empty_scroll_count}/{max_empty_scrolls})"
                )
            else:
                logger.debug(
                    f"账号 {account_name} 滚动会话列表加载更多好友 "
                    f"(scrollTop: {scroll_top_before} -> {scroll_top_after})"
                )

            time.sleep(1.5)


def do_user_task(browser, account_name, cookies, targets):
    context = browser.new_context()
    context.set_default_navigation_timeout(config["browserTimeout"])
    context.set_default_timeout(config["browserTimeout"])

    page = context.new_page()
    page.on("response", handle_response)

    context.add_cookies(cookies)

    retry_operation(
        "打开抖音网页聊天页面",
        page.goto,
        retries=config["taskRetryTimes"],
        delay=5,
        url="https://www.douyin.com/chat",
    )

    time.sleep(5)

    logger.debug(f"账号 {account_name} 开始发送消息")
    for target_symbol in scroll_and_select_user(page, account_name, targets):
        logger.debug(f"账号 {account_name} 已选中好友 {target_symbol}，准备发送消息")
        page.wait_for_selector(CHAT_EDITOR_SELECTOR, timeout=config["browserTimeout"])
        chat_input = page.locator(CHAT_EDITOR_SELECTOR)

        message = build_message()
        message_lines = message.split("\\n")
        if len(message_lines) == 1 and "\n" in message:
            message_lines = message.splitlines()

        for index, line in enumerate(message_lines):
            chat_input.type(line)
            if index < len(message_lines) - 1:
                chat_input.press("Shift+Enter")

        logger.debug(
            f"账号 {account_name} 准备发送消息给好友 {target_symbol}：\n\t{message}"
        )
        chat_input.press("Enter")
        logger.debug(f"账号 {account_name} 给好友 {target_symbol} 发送消息完成")
        time.sleep(2)

    context.close()


def runTasks():
    playwright, browser = get_browser()
    try:
        logger.info("开始执行任务")
        logger.debug("当前配置如下：")
        logger.debug(f"消息模板: {config.get('messageTemplate', '未找到消息模板')}")
        logger.debug(f"一言类型: {config['hitokotoTypes']}")
        for user in userData:
            logger.debug(
                f"用户: {user.get('username', '未知用户')}, 目标好友: {user['targets']}"
            )

        for user in userData:
            cookies = user["cookies"]
            targets = user["targets"]
            account_name = user.get("username", "未知用户")
            logger.info(f"开始处理账号 {account_name}")
            do_user_task(browser, account_name, cookies, targets)
            logger.info(f"账号 {account_name} 任务完成")
    finally:
        browser.close()
        playwright.stop()
