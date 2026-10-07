import SwiftUI

struct AIDataConsentView: View {
    let completion: (Bool) -> Void
    @State private var finished = false
    private var japanese: Bool {
        let choice = AppLanguage(rawValue: UserDefaults.standard.string(forKey: "appLanguage") ?? "system") ?? .system
        return choice.readerLanguageCode == "ja"
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: "hand.raised.shield").font(.largeTitle)
                    Text(japanese ? "AIへのデータ共有" : "Sharing data with AI").font(.largeTitle.bold())
                    Text(japanese
                         ? "ワークスペースでは、AIへの質問だけでなく、会話の翻訳・要約や依頼の整理にも外部AIを使います。開始する前に、次のデータ共有を許可してください。"
                         : "Your workspace uses external AI for questions, conversation translation and summaries, and organizing requests. Please review and allow this sharing before opening the workspace.")
                    section(japanese ? "送信するデータ" : "Data sent", japanese
                            ? "入力した文章、文字起こしのテキスト、関連するメッセージ・依頼・決定履歴、氏名や役割を含むチーム情報、プロフィールの仕事の文脈、処理に必要な添付内容や接続サービスの情報。内容に個人情報が含まれる場合、その情報も送信されます。iOSの音声入力のマイク音声は送信しません。"
                            : "Your text and transcripts; relevant messages, requests and decision history; team names and roles; work context from your profile; and relevant attachment content and connected-service information. This includes personal information contained in that content. Microphone audio from iOS dictation is not sent.")
                    section(japanese ? "送信先と目的" : "Recipients and purpose", japanese
                            ? "OpenAI：回答、下書き、翻訳、要約。ワークスペースの設定によってはOpenRouterおよび選択されたモデルの提供者を使います。追加のAIエージェントにはAnthropic（Claude）、動画解析にはGoogle（Gemini）を使用する場合があります。情報はHonmaru AIのサーバーを経由して、該当する機能の処理のために送信されます。"
                            : "OpenAI processes answers, drafts, translations and summaries. Depending on workspace configuration, OpenRouter and the selected model provider may process them instead. Optional AI agents may use Anthropic (Claude), and video analysis may use Google (Gemini). Honmaru AI sends the relevant information through its servers to process these features.")
                    Text(japanese
                         ? "許可しない場合はワークスペースを開かず、サインイン画面に戻ります。デモは外部AIに送信せず利用できます。許可は今回のサインイン中だけ有効です。サインアウトすると終了し、次回のサインイン時に再確認します。既にチームへ共有した情報の保存や、他のメンバーが開始した処理は取り消されません。"
                         : "If you decline, the workspace stays closed and you return to sign-in. You can explore the demo without sending data to external AI. Permission lasts for this sign-in only; signing out ends it, and we ask again next time. This does not remove information already shared with your team or cancel processing started by other members.")
                    Link(japanese ? "プライバシーポリシーを読む" : "Read the Privacy Policy", destination: URL(string: "https://app.honmaruai.com/privacy.html")!)
                    Button(japanese ? "許可してワークスペースを開く" : "Allow and open workspace") { finish(true) }
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("aiConsent.allow")
                    Button(japanese ? "今は許可しない" : "Not now") { finish(false) }
                        .accessibilityIdentifier("aiConsent.decline")
                }.padding(24).frame(maxWidth: 640)
            }.navigationTitle(japanese ? "AIデータ共有の確認" : "AI data sharing")
                .navigationBarTitleDisplayMode(.inline)
        }.disabled(finished)
    }
    private func section(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) { Text(title).font(.headline); Text(body) }
    }
    private func finish(_ allowed: Bool) {
        guard !finished else { return }
        finished = true
        completion(allowed)
    }
}
