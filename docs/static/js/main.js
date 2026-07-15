const { createApp, ref, reactive, computed } = Vue;
const app = createApp({
  setup() {
    const message = ref("Hello vue!");

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
          cookies: "cookie1",
          targets: ["friend1", "friend2"],
        },
      ],
    });

    const githubForm = reactive({
      owner: localStorage.getItem("gh_owner") || "",
      repo: localStorage.getItem("gh_repo") || "DouYinSparkFlow",
      token: localStorage.getItem("gh_token") || "",
    });

    const deploying = ref(false);
    const loadingConfig = ref(false);
    const running = ref(false);
    const deployResult = ref("");
    const deployStatus = ref("success");

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

    async function encryptSecret(publicKey, secretValue) {
      await sodium.ready;
      const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
      const msgBytes = sodium.from_string(secretValue);
      const encBytes = sodium.crypto_box_seal(msgBytes, keyBytes);
      return sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);
    }

    async function getPublicKey() {
      const resp = await fetch(`${apiBase()}/actions/secrets/public-key`, {
        headers: getApiHeaders(),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`获取加密公钥失败 (${resp.status}): ${body}`);
      }
      return await resp.json();
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
      const resp = await fetch(`${envBase()}/variables/${name}`, {
        method: "PUT",
        headers: getApiHeaders(),
        body: JSON.stringify({ name, value: val }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`设置变量 ${name} 失败 (${resp.status}): ${body}`);
      }
    }

    async function setSecret(name, value, publicKey) {
      const keyId = publicKey.key_id;
      const encrypted = await encryptSecret(publicKey.key, String(value));
      const resp = await fetch(`${envBase()}/secrets/${name}`, {
        method: "PUT",
        headers: getApiHeaders(),
        body: JSON.stringify({
          encrypted_value: encrypted,
          key_id: keyId,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`设置密钥 ${name} 失败 (${resp.status}): ${body}`);
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
      loadingConfig.value = true;
      deployResult.value = "";
      try {
        deployResult.value = "正在加载配置...";
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
            form.ACCOUNTS = (val || []).map(t => {
              const uid = t.unique_id || "";
              return {
                username: t.username || "",
                unique_id: uid,
                cookies: localStorage.getItem("cookies_" + uid) || cloudCookies[uid] || "",
                targets: t.targets || [],
              };
            });
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

    const deployAndRun = async () => {
      if (!githubForm.owner || !githubForm.repo || !githubForm.token) {
        deployResult.value = "请先填写 GitHub 仓库所有者、仓库名和 Token";
        deployStatus.value = "warning";
        return;
      }

      localStorage.setItem("gh_owner", githubForm.owner);
      localStorage.setItem("gh_repo", githubForm.repo);
      localStorage.setItem("gh_token", githubForm.token);

      deploying.value = true;
      deployResult.value = "";
      deployStatus.value = "success";

      try {
        deployResult.value = "正在获取加密公钥...";
        const publicKey = await getPublicKey();

        deployResult.value = "正在写入环境变量...";
        const vars = environmentVariables.value;
        for (const [name, value] of Object.entries(vars)) {
          await setVariable(name, value);
        }

        deployResult.value = "正在写入密钥...";
        const cookiesBackup = {};
        form.ACCOUNTS.forEach(a => {
          if (a.unique_id && a.cookies) {
            localStorage.setItem("cookies_" + a.unique_id, a.cookies);
            cookiesBackup[a.unique_id] = a.cookies;
          }
        });
        await setVariable("COOKIES_BACKUP", JSON.stringify(cookiesBackup));
        const secrets = environmentSecrets.value;
        for (const [name, value] of Object.entries(secrets)) {
          await setSecret(name, value, publicKey);
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
      window.open("https://github.com/settings/tokens/new?scopes=workflow", "_blank");
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
      form.ACCOUNTS.push({ username: "", unique_id: "", cookies: "", targets: [] });
    };

    const removeAccount = (index) => {
      form.ACCOUNTS.splice(index, 1);
    };

    return {
      match_mode_options,
      log_level_options,
      message,
      form,
      githubForm,
      deploying,
      deployResult,
      deployStatus,
      environmentVariables,
      environmentSecrets,
      copyValue,
      copyEnvFile,
      openEnvDetails,
      addAccount,
      removeAccount,
      deployAndRun,
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
