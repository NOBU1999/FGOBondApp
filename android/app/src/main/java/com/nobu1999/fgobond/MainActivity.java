package com.nobu1999.fgobond;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义插件：把 Python 计算引擎暴露给界面（window.fgo.calculate 最终落到它）
        registerPlugin(PythonEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
