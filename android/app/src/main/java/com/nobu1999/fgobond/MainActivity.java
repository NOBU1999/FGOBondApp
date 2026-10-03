package com.nobu1999.fgobond;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义插件：把 Python 计算引擎暴露给界面（window.fgo.calculate 最终落到它）
        registerPlugin(PythonEnginePlugin.class);
        super.onCreate(savedInstanceState);   // WebView 在这之后才存在

        // 长按要留给界面做「自己的菜单 + 滑动批量选择」，所以关掉 WebView 自带的长按菜单
        // （保存图片 / 复制 / 全选 那个原生弹窗 —— JS 拦不住它，只能在宿主里关）。
        // 只用最小的两层；真机上如果仍然弹，再启用下面注释掉的第三层。
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setLongClickable(false);
            webView.setOnCreateContextMenuListener((menu, v, menuInfo) -> {
                // 不放任何菜单项 = 不弹菜单
            });
            // 第三层（兜底）：直接吃掉长按。
            // 代价：输入框里「长按选中文字 / 粘贴」也会一起失效，所以先别开。
            // webView.setOnLongClickListener(v -> true);
        }
    }
}
