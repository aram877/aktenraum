import uvicorn

from .main import create_app


def main() -> None:
    uvicorn.run(
        create_app(),
        host="0.0.0.0",
        port=8002,
        log_config=None,
    )


if __name__ == "__main__":
    main()
