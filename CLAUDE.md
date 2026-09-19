# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

原価管理App（cost-mgmt-prod）。現時点ではディレクトリは空でコードベースは未着手のため、
ビルド／テスト／実行コマンドやアーキテクチャの記載はまだありません。コードが追加され次第、
このセクションを更新してください。

## Git運用ルール

- **コードを変更するたびに、コミットしてGitHubにpushすること。** 変更を溜め込まず、変更単位ごとに
  コミット・pushまで完了させる。
- コミットメッセージは変更内容が分かる簡潔な日本語または英語で書く。
- pushは基本的にリモートの作業ブランチ（または指示されたブランチ）に対して行う。mainブランチへの
  直接pushや force push が必要な場合は、事前にユーザーに確認する。
- このディレクトリはまだgitリポジトリとして初期化されていない。作業を始める前に `git init` の実行と
  GitHubリモートリポジトリの設定が必要。
