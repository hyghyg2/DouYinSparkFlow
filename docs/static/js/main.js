const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount } = Vue;
const app = createApp({
  setup() {
    const CLOUD_CONFIG_PATH = "cloud-config/user-data.enc.json";
    const DEFAULT_CLOUD_CONFIG_KEY = "qweasd..";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const message = ref("Hello vue!");
    const activePage = ref("deploy");
    const viewportWidth = ref(window.innerWidth);
    const isMobile = computed(() => viewportWidth.value < 768);
    const showBaseConfig = ref(false);
    const activeAccountIndex = ref(0);

    const match_mode_options = [
      { id: "nickname", label: "昵称", value: "nickname" },
      { id: "short_id", label: "抖音号", value: "short_id" },
    ];

    const log_level_options = [
      { id: "Debug", label: "Debug", value: "Debug" },
      { id: "Info", label: "Info", value: "Info" },
      { id: "Warning", label: "Warning", value: "Warning" },
      { id: "Error", label: "Error", value: "Error" },
    ];

    const form = reactive({
      PROXY_ADDRESS: "",
      MESSAGE_TEMPLATE: "[盖瑞]今日火花[加一]\n—— [右边] 每日一言 [左边] ——\n[API]",
      HITOKOTO_TYPES: ["文学", "影视", "诗词", "哲学"],
      MATCH_MODE: "nickname",
      BROWSER_TIMEOUT: 120000,
      FRIEND_LIST_WAIT_TIME: 2000,
      TASK_RETRY_TIMES: 3,
      LOG_LEVEL: "Info",
      ACCOUNTS: [
        {
          username: "user1",
          unique_id: "12345678905",
          remark: "",
          cookies: "cookie1",
          targets: ["friend1", "friend2"],
        },
      ],
    });

    const githubForm = reactive({
      owner: localStorage.getItem("gh_owner") || "",
      repo: localStorage.getItem("gh_repo") || "DouYinSparkFlow",
      token: localStorage.getItem("gh_token") || "",
      cloudConfigKey: localStorage.getItem("cloud_config_key") || DEFAULT_CLOUD_CONFIG_KEY,
    });

    const deploying = ref(false);
    const savingCloud = ref(false);
    const loadingConfig = ref(false);
    const running = ref(false);
    const deployResult = ref("");
    const deployStatus = ref("success");

    const createAccount = (overrides = {}) => ({
      username: "",
      unique_id: "",
      remark: "",
      cookies: "",
      targets: [],
      ...overrides,
      targets: Array.isArray(overrides.targets) ? overrides.targets : [],
    });

    const normalizeAccount = (account = {}) => createAccount({
      username: account.username || "",
      unique_id: account.unique_id || "",
      remark: account.remark || account.note || "",
      cookies: account.cookies || "",
      targets: Array.isArray(account.targets) ? account.targets : [],
    });

    const setAccounts = (accounts) => {
      const nextAccounts = Array.isArray(accounts) && accounts.length > 0
        ? accounts.map((account) => normalizeAccount(account))
        : [createAccount()];
      form.ACCOUNTS = nextAccounts;
      nextAccounts.forEach((account) => {
        const uid = String(account.unique_id || "").trim();
        if (uid && account.cookies) {
          localStorage.setItem("cookies_" + uid, account.cookies);
        }
      });
      if (activeAccountIndex.value >= nextAccounts.length) {
        activeAccountIndex.value = nextAccounts.length - 1;
      }
      if (activeAccountIndex.value < 0) {
        activeAccountIndex.value = 0;
      }
    };

    const handleResize = () => {
      viewportWidth.value = window.innerWidth;
    };

    onMounted(() => {
      window.addEventListener("resize", handleResize);
    });

    onBeforeUnmount(() => {
      window.removeEventListener("resize", handleResize);
    });

    const environmentVariables = computed(() => {
      return {
        PROXY_ADDRESS: form.PROXY_ADDRESS,
        MESSAGE_TEMPLATE: form.MESSAGE_TEMPLATE,
        HITOKOTO_TYPES: form.HITOKOTO_TYPES,
        MATCH_MODE: form.MATCH_MODE,
        BROWSER_TIMEOUT: form.BROWSER_TIMEOUT,
        FRIEND_LIST_WAIT_TIME: form.FRIEND_LIST_WAIT_TIME,
        TASK_RETRY_TIMES: form.TASK_RETRY_TIMES,
        LOG_LEVEL: form.LOG_LEVEL,
        TASKS: form.ACCOUNTS.map((account) => ({
          username: account.username,
          unique_id: account.unique_id,
          remark: account.remark || "",
          targets: account.targets,
        })),
      };
    });

    const environmentSecrets = computed(() => {
      return form.ACCOUNTS.reduce((acc, account, index) => {
        acc[`COOKIES_${String(account.unique_id || "").toUpperCase()}`] = account.cookies;
        return acc;
      }, {});
    });

    const getApiHeaders = () => ({
      "Authorization": `Bearer ${githubForm.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    });

    const apiBase = () =>
      `https://api.github.com/repos/${githubForm.owner}/${githubForm.repo}`;

    const envBase = () => `${apiBase()}/environments/user-data`;

    const chunkStringFromBytes = (bytes) => {
      const chunkSize = 0x8000;
      let result = "";
      for (let i = 0; i < bytes.length; i += chunkSize) {
        result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return result;
    };

    const bytesToBase64 = (bytes) => btoa(chunkStringFromBytes(bytes));

    const base64ToBytes = (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    };

    const utf8ToBase64 = (value) => bytesToBase64(encoder.encode(value));

    const base64ToUtf8 = (value) => decoder.decode(base64ToBytes(value));

    const ensureCryptoSupport = () => {
      if (!window.crypto?.subtle) {
        throw new Error("当前浏览器不支持云端加密备份，请换用较新的浏览器");
      }
    };

    async function importAesKeyFromSeed(seed) {
      const keyBytes = await window.crypto.subtle.digest("SHA-256", encoder.encode(seed));
      return window.crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
    }

    async function deriveCloudKeyFromValue(value) {
      ensureCryptoSupport();
      const cloudConfigKey = String(value || "").trim();
      if (!cloudConfigKey) {
        throw new Error("请先填写云端配置密钥");
      }

      return importAesKeyFromSeed(`DouYinSparkFlow::cloud-config-key::${cloudConfigKey}`);
    }

    async function deriveCloudKey() {
      return deriveCloudKeyFromValue(githubForm.cloudConfigKey || DEFAULT_CLOUD_CONFIG_KEY);
    }

    async function deriveTokenCloudKey() {
      ensureCryptoSupport();
      const token = String(githubForm.token || "").trim();
      if (!token) {
        throw new Error("请先填写 GitHub Token");
      }

      return importAesKeyFromSeed(`DouYinSparkFlow::${token}`);
    }

    async function deriveLegacyCloudKey() {
      ensureCryptoSupport();
      const seed = `${githubForm.token}::${githubForm.owner}/${githubForm.repo}`;
      return importAesKeyFromSeed(seed);
    }

    function buildCloudConfig() {
      return {
        version: 3,
        savedAt: new Date().toISOString(),
        form: JSON.parse(JSON.stringify(form)),
      };
    }

    function applyCloudConfig(payload) {
      const nextForm = payload?.form || payload;
      if (!nextForm || typeof nextForm !== "object") {
        throw new Error("云端配置格式无效");
      }

      const nextAccounts = Array.isArray(nextForm.ACCOUNTS) && nextForm.ACCOUNTS.length > 0
        ? nextForm.ACCOUNTS
        : [createAccount()];

      form.PROXY_ADDRESS = nextForm.PROXY_ADDRESS || "";
      form.MESSAGE_TEMPLATE = nextForm.MESSAGE_TEMPLATE || "";
      form.HITOKOTO_TYPES = Array.isArray(nextForm.HITOKOTO_TYPES) ? nextForm.HITOKOTO_TYPES : [];
      form.MATCH_MODE = nextForm.MATCH_MODE || "nickname";
      form.BROWSER_TIMEOUT = Number(nextForm.BROWSER_TIMEOUT) || 120000;
      form.FRIEND_LIST_WAIT_TIME = Number(nextForm.FRIEND_LIST_WAIT_TIME) || 2000;
      form.TASK_RETRY_TIMES = Number(nextForm.TASK_RETRY_TIMES) || 3;
      form.LOG_LEVEL = nextForm.LOG_LEVEL || "Info";
      setAccounts(nextAccounts);
    }

    async function encryptCloudConfig(payload) {
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveCloudKey();
      const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(JSON.stringify(payload))
      );

      return JSON.stringify({
        version: 3,
        algorithm: "AES-GCM",
        keySource: "cloud-config-key",
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      }, null, 2);
    }

    async function decryptCloudConfig(encryptedText) {
      const parsed = JSON.parse(encryptedText);
      if (!parsed?.iv || !parsed?.ciphertext) {
        throw new Error("云端配置缺少加密字段");
      }

      const payloadBytes = base64ToBytes(parsed.ciphertext);
      const isCloudKeyBackup = parsed.keySource === "cloud-config-key" || Number(parsed.version) >= 3;
      const currentCloudKey = String(githubForm.cloudConfigKey || "").trim();
      const cloudKeyCandidates = [...new Set([
        currentCloudKey,
        DEFAULT_CLOUD_CONFIG_KEY,
      ].filter(Boolean))];

      const attempts = isCloudKeyBackup
        ? cloudKeyCandidates.map((candidate) => () => deriveCloudKeyFromValue(candidate))
        : [deriveCloudKey, deriveTokenCloudKey, deriveLegacyCloudKey];

      for (let i = 0; i < attempts.length; i++) {
        const deriveKeyFn = attempts[i];
        try {
          const key = await deriveKeyFn();
          const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
            key,
            payloadBytes
          );
          if (isCloudKeyBackup && cloudKeyCandidates[i] === DEFAULT_CLOUD_CONFIG_KEY) {
            githubForm.cloudConfigKey = DEFAULT_CLOUD_CONFIG_KEY;
            localStorage.setItem("cloud_config_key", DEFAULT_CLOUD_CONFIG_KEY);
          }
          return JSON.parse(decoder.decode(decrypted));
        } catch {}
      }

      if (isCloudKeyBackup) {
        throw new Error("云端配置解密失败，请确认云端配置密钥是否正确");
      }
      throw new Error("云端配置解密失败，请确认云端配置密钥或旧 Token 是否正确");
    }

    async function getRepoDefaultBranch() {
      const resp = await fetch(apiBase(), { headers: getApiHeaders() });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`获取仓库信息失败 (${resp.status}): ${body}`);
      }
      const data = await resp.json();
      return data.default_branch || "main";
    }

    async function getRepoFile(path) {
      const resp = await fetch(`${apiBase()}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
        headers: getApiHeaders(),
      });

      if (resp.status === 404) {
        return null;
      }
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`读取云端文件失败 (${resp.status}): ${body}`);
      }

      return await resp.json();
    }

    async function putRepoFile(path, content, messageText) {
      const branch = await getRepoDefaultBranch();
      const existing = await getRepoFile(path);
      const resp = await fetch(`${apiBase()}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
        method: "PUT",
        headers: getApiHeaders(),
        body: JSON.stringify({
          message: messageText,
          branch,
          content: utf8ToBase64(content),
          sha: existing?.sha,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`写入云端文件失败 (${resp.status}): ${body}`);
      }

      return await resp.json();
    }

    async function saveCloudConfigToRepo() {
      const payload = buildCloudConfig();
      const encrypted = await encryptCloudConfig(payload);
      await putRepoFile(CLOUD_CONFIG_PATH, encrypted, "chore: update cloud config backup");
    }

    async function loadCloudConfigFromRepo() {
      const file = await getRepoFile(CLOUD_CONFIG_PATH);
      if (!file?.content) {
        return false;
      }

      const encryptedText = base64ToUtf8(String(file.content).replace(/\n/g, ""));
      let config;
      try {
        config = await decryptCloudConfig(encryptedText);
      } catch (e) {
        throw new Error(e.message || "云端配置解密失败，请确认云端配置密钥是否正确");
      }
      applyCloudConfig(config);
      return true;
    }

    async function loadCookiesFromCloud() {
      try {
        const resp = await fetch(`${envBase()}/variables/COOKIES_BACKUP`, { headers: getApiHeaders() });
        if (!resp.ok) return {};
        const data = await resp.json();
        return JSON.parse(data.value || "{}");
      } catch (e) { return {}; }
    }

    const setVariable = async (name, value) => {
      const val = typeof value === "object" ? JSON.stringify(value) : String(value);
      let resp = await fetch(`${envBase()}/variables/${name}`, {
        method: "PATCH",
        headers: getApiHeaders(),
        body: JSON.stringify({ name, value: val }),
      });
      if (resp.status === 404) {
        resp = await fetch(`${envBase()}/variables`, {
          method: "POST",
          headers: getApiHeaders(),
          body: JSON.stringify({ name, value: val }),
        });
      }
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`设置变量 ${name} 失败 (${resp.status}): ${body}`);
      }
    }

    async function triggerWorkflow() {
      const resp = await fetch(`${apiBase()}/actions/workflows/schedule.yml/dispatches`, {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({ ref: "main" }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`触发运行失败 (${resp.status}): ${body}`);
      }
    }

    const loadFromGitHub = async () => {
      if (!githubForm.owner || !githubForm.repo || !githubForm.token) {
        deployResult.value = "请先填写 GitHub 仓库所有者、仓库名和 Token";
        deployStatus.value = "warning";
        return;
      }
      localStorage.setItem("gh_owner", githubForm.owner);
      localStorage.setItem("gh_repo", githubForm.repo);
      localStorage.setItem("gh_token", githubForm.token);
      if (githubForm.cloudConfigKey) {
        localStorage.setItem("cloud_config_key", githubForm.cloudConfigKey);
      }
      loadingConfig.value = true;
      deployResult.value = "";
      try {
        deployResult.value = "正在加载云端配置...";
        let loadedFromBackup = false;
        try {
          loadedFromBackup = await loadCloudConfigFromRepo();
        } catch (e) {}
        if (loadedFromBackup) {
          deployStatus.value = "success";
          deployResult.value = "已从云端加密备份加载配置。";
          ElementPlus.ElMessage.success("云端配置加载完成");
          return;
        }

        deployResult.value = "正在加载环境配置...";
        const [resp, cloudCookies] = await Promise.all([
          fetch(`${envBase()}/variables`, { headers: getApiHeaders() }),
          loadCookiesFromCloud(),
        ]);
        if (!resp.ok) throw new Error(`加载失败 (${resp.status})`);
        const data = await resp.json();
        for (const v of data.variables || []) {
          let val = v.value;
          if (v.name === "HITOKOTO_TYPES" || v.name === "TASKS") {
            try { val = JSON.parse(val); } catch(e) {}
          }
          if (v.name === "BROWSER_TIMEOUT" || v.name === "FRIEND_LIST_WAIT_TIME" || v.name === "TASK_RETRY_TIMES") {
            val = parseInt(val) || val;
          }
          if (v.name === "TASKS") {
            const tasks = Array.isArray(val) ? val : [];
            setAccounts(tasks.map(t => {
              const uid = t.unique_id || "";
              return {
                username: t.username || "",
                unique_id: uid,
                remark: t.remark || t.note || "",
                cookies: localStorage.getItem("cookies_" + uid) || cloudCookies[uid] || "",
                targets: t.targets || [],
              };
            }));
            continue;
          }
          if (v.name in form) form[v.name] = val;
        }
        deployStatus.value = "success";
        deployResult.value = "配置已加载！Cookies 需手动填写（GitHub 不返回密钥值）。";
        ElementPlus.ElMessage.success("配置加载完成");
      } catch (e) {
        deployStatus.value = "error";
        deployResult.value = e.message || "加载失败";
      } finally {
        loadingConfig.value = false;
      }
    };

    const triggerRun = async () => {
      if (!githubForm.owner || !githubForm.repo || !githubForm.token) {
        deployResult.value = "请先填写 GitHub 仓库所有者、仓库名和 Token";
        deployStatus.value = "warning";
        return;
      }
      running.value = true;
      deployResult.value = "";
      try {
        deployResult.value = "正在触发运行...";
        await triggerWorkflow();
        deployStatus.value = "success";
        deployResult.value = "运行已触发！请稍后在 GitHub Actions 中查看结果。";
        ElementPlus.ElMessage.success("运行已触发");
      } catch (e) {
        deployStatus.value = "error";
        deployResult.value = e.message || "触发失败";
      } finally {
        running.value = false;
      }
    };

    const saveCloudConfigOnly = async () => {
      if (!githubForm.owner || !githubForm.repo || !githubForm.token) {
        deployResult.value = "请先填写 GitHub 仓库所有者、仓库名和 Token";
        deployStatus.value = "warning";
        return;
      }
      if (!githubForm.cloudConfigKey) {
        deployResult.value = "请先填写云端配置密钥";
        deployStatus.value = "warning";
        return;
      }

      localStorage.setItem("gh_owner", githubForm.owner);
      localStorage.setItem("gh_repo", githubForm.repo);
      localStorage.setItem("gh_token", githubForm.token);
      localStorage.setItem("cloud_config_key", githubForm.cloudConfigKey);

      savingCloud.value = true;
      deployResult.value = "";
      deployStatus.value = "success";

      try {
        deployResult.value = "正在保存云端配置...";
        await saveCloudConfigToRepo();
        deployResult.value = "云端配置已保存，换设备后可直接加载。";
        ElementPlus.ElMessage.success("云端配置保存成功");
      } catch (e) {
        deployStatus.value = "error";
        deployResult.value = e.message || "云端保存失败";
        ElementPlus.ElMessage.error(deployResult.value);
      } finally {
        savingCloud.value = false;
      }
    };

    const deployAndRun = async () => {
      if (!githubForm.owner || !githubForm.repo || !githubForm.token) {
        deployResult.value = "请先填写 GitHub 仓库所有者、仓库名和 Token";
        deployStatus.value = "warning";
        return;
      }
      if (!githubForm.cloudConfigKey) {
        deployResult.value = "请先填写云端配置密钥";
        deployStatus.value = "warning";
        return;
      }

      localStorage.setItem("gh_owner", githubForm.owner);
      localStorage.setItem("gh_repo", githubForm.repo);
      localStorage.setItem("gh_token", githubForm.token);
      localStorage.setItem("cloud_config_key", githubForm.cloudConfigKey);

      deploying.value = true;
      deployResult.value = "";
      deployStatus.value = "success";

      try {
        deployResult.value = "正在保存云端配置...";
        await saveCloudConfigToRepo();

        deployResult.value = "正在写入环境变量...";
        const vars = environmentVariables.value;
        for (const [name, value] of Object.entries(vars)) {
          if (name === "PROXY_ADDRESS" && !value) continue;
          await setVariable(name, value);
        }

        deployResult.value = "正在写入 Cookies 配置...";
        const cookiesBackup = {};
        form.ACCOUNTS.forEach(a => {
          if (a.unique_id && a.cookies) {
            localStorage.setItem("cookies_" + a.unique_id, a.cookies);
            cookiesBackup[a.unique_id] = a.cookies;
          }
        });
        if (Object.keys(cookiesBackup).length > 0) {
          await setVariable("COOKIES_BACKUP", JSON.stringify(cookiesBackup));
        }
        for (const [name, value] of Object.entries(environmentSecrets.value)) {
          if (value) await setVariable(name, value);
        }

        deployResult.value = "正在触发运行...";
        await triggerWorkflow();

        deployStatus.value = "success";
        deployResult.value = "部署成功！已触发运行，请稍后在 GitHub Actions 中查看结果。";
        ElementPlus.ElMessage.success("部署并运行成功！");
      } catch (e) {
        deployStatus.value = "error";
        deployResult.value = e.message || "部署失败";
        ElementPlus.ElMessage.error(deployResult.value);
      } finally {
        deploying.value = false;
      }
    };

    const openTokenHelp = () => {
      window.open("https://github.com/settings/tokens/new?scopes=repo,workflow", "_blank");
    };

    const switchPage = (page) => {
      activePage.value = page;
    };

    const toggleBaseConfig = () => {
      showBaseConfig.value = !showBaseConfig.value;
    };

    const switchAccount = () => {
      if (form.ACCOUNTS.length <= 1) return;
      activeAccountIndex.value = (activeAccountIndex.value + 1) % form.ACCOUNTS.length;
    };

    const setActiveAccount = (index) => {
      if (index >= 0 && index < form.ACCOUNTS.length) {
        activeAccountIndex.value = index;
      }
    };

    const copyValue = (value) => {
      if (typeof value === "object") {
        value = JSON.stringify(value);
      } else if (typeof value === "number") {
        value = value.toString();
      } else {
        value = value.replace(/\n/g, "\\n");
      }
      navigator.clipboard.writeText(value).then(
        () => { ElementPlus.ElMessage.success("已复制到剪贴板"); },
        (err) => { ElementPlus.ElMessage.error("复制失败: " + err); }
      );
    };

    const copyEnvFile = () => {
      const allVars = {
        ...environmentVariables.value,
        ...environmentSecrets.value,
      };
      const item = Object.entries(allVars)
        .map(([key, value]) => {
          if (typeof value === "object") value = JSON.stringify(value);
          else if (typeof value === "number") value = value.toString();
          else value = value.replace(/\n/g, "\\n");
          return `${key}=${value}`;
        })
        .join("\n");
      navigator.clipboard.writeText(item).then(
        () => { ElementPlus.ElMessage.success("已复制 .env 配置文件到剪贴板"); },
        (err) => { ElementPlus.ElMessage.error("复制失败: " + err); }
      );
    };

    const openEnvDetails = (name, value) => {
      if (typeof value === "object") value = JSON.stringify(value, null, 2);
      ElementPlus.ElMessageBox.alert(
        "<div style='text-align:left;white-space:pre-wrap;word-break:break-all;width:400px;max-height:200px;overflow:auto'>" +
          value + "</div>",
        `${name} 详情`,
        { dangerouslyUseHTMLString: true }
      );
    };

    const addAccount = () => {
      form.ACCOUNTS.push(createAccount());
      activeAccountIndex.value = form.ACCOUNTS.length - 1;
    };

    const removeAccount = (index = activeAccountIndex.value) => {
      if (form.ACCOUNTS.length <= 1) return;
      form.ACCOUNTS.splice(index, 1);
      if (activeAccountIndex.value > index) {
        activeAccountIndex.value -= 1;
      }
      if (activeAccountIndex.value >= form.ACCOUNTS.length) {
        activeAccountIndex.value = form.ACCOUNTS.length - 1;
      }
    };

    const activeAccount = computed(() => form.ACCOUNTS[activeAccountIndex.value] || form.ACCOUNTS[0] || null);

    return {
      match_mode_options,
      log_level_options,
      message,
      activePage,
      isMobile,
      showBaseConfig,
      activeAccountIndex,
      activeAccount,
      form,
      githubForm,
      deploying,
      savingCloud,
      deployResult,
      deployStatus,
      environmentVariables,
      environmentSecrets,
      copyValue,
      copyEnvFile,
      openEnvDetails,
      addAccount,
      removeAccount,
      switchPage,
      toggleBaseConfig,
      switchAccount,
      setActiveAccount,
      deployAndRun,
      saveCloudConfigOnly,
      loadFromGitHub,
      triggerRun,
      loadingConfig,
      running,
      openTokenHelp,
    };
  },
});
app.use(ElementPlus);
app.mount("#app");
