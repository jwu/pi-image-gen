import { describe, expect, test } from "bun:test"
import { ImageGenError, mapUpstreamFailure, summarizeUpstreamBody } from "../src/util/errors.ts"

describe("mapUpstreamFailure", () => {
  test("5xx 归类为上游不可用", () => {
    const error = mapUpstreamFailure({ status: 503, message: "boom" }, "openai")
    expect(error).toBeInstanceOf(ImageGenError)
    expect(error.message).toContain("temporarily unavailable")
  })

  test("401 提示检查凭据", () => {
    expect(mapUpstreamFailure({ status: 401 }, "openai").message).toContain(
      "credentials are unavailable",
    )
  })

  test("403 是权限或额度，不当成凭据问题", () => {
    // Grok 用 403 表示模型权限或额度限制，说成“凭据不可用”会把人带偏。
    const error = mapUpstreamFailure({ status: 403 }, "grok")
    expect(error.message).toContain("refused the request")
    expect(error.message).not.toContain("credentials are unavailable")
  })

  test("402 单独报额度用完", () => {
    expect(mapUpstreamFailure({ status: 402 }, "grok").message).toContain("out of quota")
  })

  test("codex 的鉴权失败提示重新登录", () => {
    expect(mapUpstreamFailure({ status: 401 }, "codex").message).toContain("/image-gen login codex")
  })

  test("ChatGPT 订阅凭据被硬边界拦住时指明出路", () => {
    const error = mapUpstreamFailure(
      {
        status: 401,
        code: "hardened_oauth_rule_missing",
        message: "This ChatPass credential is not authorized for the requested operation.",
      },
      "openai",
    )
    expect(error.message).toContain("not authorized for image generation")
    expect(error.message).toContain("OpenAI API key")
    expect(error.message).toContain("/image-gen login codex")
    // 不应该落到笼统的“凭据不可用”。
    expect(error.message).not.toContain("credentials are unavailable")
  })

  test("404 与 model_not_found 都指向模型名", () => {
    expect(mapUpstreamFailure({ status: 404 }, "openai").message).toContain("does not exist")
    expect(
      mapUpstreamFailure({ status: 400, code: "model_not_found" }, "openai").message,
    ).toContain("does not exist")
  })

  test("额度不足与限流都归到 429 文案", () => {
    expect(mapUpstreamFailure({ status: 429 }, "openai").message).toContain("Rate limited")
    expect(
      mapUpstreamFailure({ status: 400, code: "insufficient_quota" }, "openai").message,
    ).toContain("Rate limited")
  })

  test("审核拦截优先于通用文案", () => {
    const error = mapUpstreamFailure(
      { status: 400, message: "Your request was rejected by the safety system" },
      "openai",
    )
    expect(error.message).toContain("safety system")
  })

  test("上游点名不支持的参数时回显参数名", () => {
    const error = mapUpstreamFailure(
      { status: 400, message: "This model does not support the size parameter" },
      "grok",
    )
    expect(error.message).toContain("size")
  })

  test("识别不了的原因不猜，落到通用文案", () => {
    const error = mapUpstreamFailure({ status: 400, message: "something odd" }, "openai")
    expect(error.message).toBe("Image generation failed. Try again shortly.")
  })

  test("只保留 code / requestId / upstreamMs，不带上游原文", () => {
    const error = mapUpstreamFailure(
      {
        status: 500,
        code: "server_error",
        message: "secret upstream detail",
        requestId: "req_1",
        upstreamMs: 1234,
      },
      "openai",
    )
    expect(error.code).toBe("server_error")
    expect(error.requestId).toBe("req_1")
    expect(error.upstreamMs).toBe(1234)
    expect(error.message).not.toContain("secret upstream detail")
  })
})

describe("summarizeUpstreamBody", () => {
  test("取嵌套 error 的 code 与 message", () => {
    expect(summarizeUpstreamBody({ error: { code: "x", message: "y" } })).toEqual({
      code: "x",
      message: "y",
    })
  })

  test("取顶层的 code / message / request_id", () => {
    expect(summarizeUpstreamBody({ code: "c", message: "m", request_id: "r" })).toEqual({
      code: "c",
      message: "m",
      requestId: "r",
    })
  })

  test("非对象输入返回空", () => {
    expect(summarizeUpstreamBody("nope")).toEqual({})
    expect(summarizeUpstreamBody(null)).toEqual({})
  })
})
