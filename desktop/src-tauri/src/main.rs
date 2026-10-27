// 发布版不弹出命令行窗口；--serve 命令行模式用调试版运行
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ruilink::main_entry()
}
