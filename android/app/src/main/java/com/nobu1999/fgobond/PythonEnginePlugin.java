package com.nobu1999.fgobond;

import android.content.Context;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 把计算引擎（真 CPython，经 Chaquopy）暴露给界面。
 *
 * 协议与桌面完全一致：界面传一份请求 JSON（字符串），拿回一份结果 JSON（字符串）；
 * 出错时返回 {"status":"error","message":...} 由 JS 侧抛成异常（与 python-process.js 行为一致）。
 *
 * 数据库：引擎只读静态数据，所以把随包的 db 复制到应用私有目录，交给 Python 的 sqlite3 读。
 */
@CapacitorPlugin(name = "PythonEngine")
public class PythonEnginePlugin extends Plugin {

    private static final String DB_ASSET = "public/db/fgo_data.db";
    private static final String DB_FILE_NAME = "fgo_data.db";

    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static volatile boolean cancelled = false;

    private void ensurePythonStarted() {
        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(getContext()));
        }
    }

    /** 首次使用时把随包的静态数据复制到应用私有目录（引擎用 Python 的 sqlite3 读它） */
    private String ensureDatabase() throws IOException {
        Context ctx = getContext();
        File target = new File(ctx.getFilesDir(), DB_FILE_NAME);
        if (!target.exists() || target.length() == 0) {
            try (InputStream in = ctx.getAssets().open(DB_ASSET);
                 OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                }
            }
        }
        return target.getAbsolutePath();
    }

    private static String pythonCalculate(String dbPath, String requestJson) {
        PyObject module = Python.getInstance().getModule("fgo_engine_bridge");
        PyObject result = module.callAttr("calculate", dbPath, requestJson);
        return result == null ? "" : result.toString();
    }

    @PluginMethod
    public void calculate(PluginCall call) {
        final String requestJson = call.getString("requestJson");
        if (requestJson == null || requestJson.isEmpty()) {
            call.reject("缺少请求参数");
            return;
        }
        if (!RUNNING.compareAndSet(false, true)) {
            call.reject("引擎正在运行，请先等待当前计算结束");
            return;
        }
        cancelled = false;

        new Thread(() -> {
            try {
                ensurePythonStarted();
                String dbPath = ensureDatabase();
                String resultJson = pythonCalculate(dbPath, requestJson);
                if (cancelled) {
                    call.reject("已取消");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("resultJson", resultJson);
                call.resolve(ret);
            } catch (Throwable err) {
                String message = err.getMessage() == null ? err.toString() : err.getMessage();
                call.reject("计算引擎出错：" + message);
            } finally {
                RUNNING.set(false);
            }
        }, "fgo-engine").start();
    }

    /** 取消：无法打断已在跑的 Python 调用，这里让界面立刻停等（结果被丢弃） */
    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 引擎自检：返回 Python 版本等（供界面/调试用） */
    @PluginMethod
    public void info(PluginCall call) {
        try {
            ensurePythonStarted();
            PyObject module = Python.getInstance().getModule("fgo_engine_bridge");
            PyObject out = module.callAttr("engine_info");
            JSObject ret = new JSObject();
            ret.put("infoJson", out == null ? "{}" : out.toString());
            call.resolve(ret);
        } catch (Throwable err) {
            call.reject("引擎自检失败：" + err);
        }
    }
}
