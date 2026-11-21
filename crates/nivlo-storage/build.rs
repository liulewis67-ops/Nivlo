//! 构建脚本：`sqlx::migrate!` 在编译期嵌入 migration 文件，目录变化时需要重新编译。

fn main() {
    println!("cargo:rerun-if-changed=../../migrations");
}
